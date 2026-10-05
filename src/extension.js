'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { analyze, describeRules } = require('./analyzer');
const { planEdits } = require('./fixer');
const { verifyRewrites, downgradeRejected } = require('./verify');
const { learnAnnotations } = require('./learn');
const { buildAiPrompt, buildReport } = require('./report');
const { FindingsProvider } = require('./view');
const { Selection } = require('./selection');
const { ddicRequests } = require('./ddic');
const DdicAdt = require('./ddic-adt');
const Atc = require('./atc');
const { AtcRunner, SAVE_AND_RUN } = require('./atc-runner');
const { Preview, PREVIEW_SCHEME } = require('./preview');
const { FindingHoverProvider } = require('./hover');

/** @type {Map<string, {uri: vscode.Uri, version: number, result: object}>} */
const store = new Map();

/** Which findings are checked in the sidebar; bulk fixes only apply checked findings */
const selection = new Selection();

/** Files analyzed at least once (even without findings); only these are analyzed again while typing */
const tracked = new Set();
const typingTimers = new Map();
const TYPING_DELAY_MS = 500;

let diagnostics;
let provider;
let statusBar;
let findingsView;
let output;

const FIX_ALL_KIND = vscode.CodeActionKind.SourceFixAll.append('abap-smartfix');

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

// ---------------------------------------------------------------- settings / helpers

function cfg(uri) {
  return vscode.workspace.getConfiguration('abap-smartfix', uri || null);
}

// Virtual documents that are never analyzed: our own diff preview, git history versions, output panels
const IGNORED_SCHEMES = ['output', 'git', 'abap-smartfix-preview'];

function isAbapDoc(doc) {
  if (!doc || IGNORED_SCHEMES.indexOf(doc.uri.scheme) >= 0) return false;
  if (doc.languageId === 'abap') return true;
  const exts = cfg(doc.uri).get('fileExtensions', ['.abap']);
  const name = doc.fileName.toLowerCase();
  return exts.some((e) => name.endsWith(String(e).toLowerCase()));
}

function workspaceFile(uri, rel) {
  if (!rel) return '';
  if (path.isAbsolute(rel)) return rel;
  const folder =
    (uri && vscode.workspace.getWorkspaceFolder(uri)) ||
    (vscode.workspace.workspaceFolders || [])[0];
  return folder ? path.join(folder.uri.fsPath, rel) : '';
}

const MAX_RULES_FILE_BYTES = 1024 * 1024;

function loadCustomRules(uri) {
  // Custom rules can rewrite code: only from a workspace the user trusts
  if (vscode.workspace.isTrusted === false) return [];
  const file = workspaceFile(uri, cfg(uri).get('customRulesFile', '.abap-smartfix-rules.json'));
  if (!file) return [];
  try {
    if (!fs.existsSync(file)) return [];
    if (fs.statSync(file).size > MAX_RULES_FILE_BYTES) {
      log('Custom rules file ' + file + ' is larger than 1 MB; not read.');
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.rules || [];
  } catch (e) {
    log('Failed to read custom rules ' + file + ': ' + e.message);
    return [];
  }
}

function readOptions(uri) {
  const conf = cfg(uri);
  return {
    disabledRules: conf.get('disabledRules', []),
    enabledRules: conf.get('enabledRules', []),
    tokenOverrides: conf.get('tokenOverrides', {}),
    subrcLookahead: conf.get('subrcLookahead', 3),
    fixMode: conf.get('fixMode', 'auto'),
    ruleFixModes: conf.get('ruleFixModes', {}),
    suppressStyle: conf.get('suppressStyle', 'rule'),
    abapRelease: conf.get('abapRelease', 'latest'),
    selectSingleCheck: conf.get('selectSingleCheck', 'certain'),
    customRules: loadCustomRules(uri),
    ddic: DdicAdt.viewFor(ddicDestination(uri)),
    bufferedTables: atc.bufferedTables(uri),
  };
}

/** ADT destination whose DDIC is used for this document, or '' (DDIC lookups off or no destination) */
function ddicDestination(uri) {
  const conf = cfg(uri);
  if (!conf.get('ddic.enabled', true)) return '';
  return DdicAdt.destinationOf(uri, conf.get('ddic.destination', ''));
}

// ---------------------------------------------------------------- ATC from the SAP system (atc-runner.js)

/** @type {AtcRunner} */
let atc;

/**
 * Analysis of the document text, analyzed once per version and options: a large program takes seconds, and one command
 * needs it several times (scan, preview, confirmation, fix). Callers get their own copies of the findings, which they change.
 */
const analysisCache = new Map();
const lastAnalysisMs = new Map();

function optionsKey(opts) {
  return JSON.stringify(Object.assign({}, opts, { ddic: opts.ddic ? DdicAdt.cacheSummary() : null }));
}

function analyzeText(doc, opts) {
  const key = doc.uri.toString();
  const okey = optionsKey(opts);
  let c = analysisCache.get(key);
  if (!c || c.version !== doc.version || c.okey !== okey) {
    const start = Date.now();
    c = { version: doc.version, okey, result: analyze(doc.getText(), opts), verified: new Map() };
    lastAnalysisMs.set(key, Date.now() - start);
    analysisCache.set(key, c);
  }
  const r = c.result;
  return Object.assign({}, r, { findings: r.findings.map((f) => Object.assign({}, f)), cache: c });
}

/** Analyze a document and apply the last ATC result of it (if any) */
function analyzeDoc(doc, opts) {
  return atc.applyTo(analyzeText(doc, opts), doc, opts);
}

/**
 * Read the DDIC objects the rules could use (table types of VALUE parameters, primary keys of SELECT SINGLE tables)
 * from the SAP system through ABAP Development Tools for VS Code, then analyze the document again if anything was learned.
 * Without ADT, a destination or a logon nothing happens and the findings stay as they are.
 */
function prefetchDdic(doc) {
  const destination = ddicDestination(doc.uri);
  if (!destination || !DdicAdt.adtAvailable()) return;
  let names;
  try {
    const req = ddicRequests(doc.getText());
    names = req.types.concat(req.tables, req.programs.map((p) => 'PROG:' + p));
  } catch (e) {
    return;
  }
  if (!names.length) return;
  const key = doc.uri.toString();
  const version = doc.version;
  DdicAdt.prefetch(destination, names, log).then((learned) => {
    if (!learned) return;
    log('DDIC: ' + learned + ' object' + (learned === 1 ? '' : 's') + ' read from ' + destination + ' (' + DdicAdt.cacheSummary() + ')');
    if (tracked.has(key) && !doc.isClosed && doc.version === version) scanDocument(doc);
  }, (e) => log('DDIC lookup failed: ' + (e && e.message ? e.message : e)));
}

/** When mode is set (Quick Fix / suppress-only command), it overrides the configured fix mode */
function optionsFor(uri, mode) {
  const opts = readOptions(uri);
  if (mode) {
    opts.fixMode = mode;
    opts.ruleFixModes = {};
  }
  return opts;
}

function diagMessage(f) {
  const title = f.title + (f.detail ? ' — ' + f.detail : '');
  if (f.action === 'rewrite') return '[Auto-fixable] ' + title + ': ' + f.rewrite.summary;
  if (f.action === 'suppress') return 'Missing ' + f.token + ' (' + title + ')';
  return '[Manual] ' + title + (f.rewrite ? ' (rewrite available: ' + f.rewrite.summary + ')' : '');
}

function countActions(findings) {
  const n = { rewrite: 0, suppress: 0, manual: 0 };
  for (const f of findings) n[f.action]++;
  return n;
}

function log(msg) {
  if (output) output.appendLine('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

// ---------------------------------------------------------------- scanning

function scanDocument(doc) {
  let result;
  try {
    result = analyzeDoc(doc, readOptions(doc.uri));
  } catch (e) {
    // Never let one text (e.g. half-typed code) stop the analysis of later versions: log it and show no findings for now
    log('Analysis of ' + doc.fileName + ' failed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    result = { findings: [], statements: [], lines: [], comments: [] };
  }
  const key = doc.uri.toString();
  tracked.add(key);
  if (result.findings.length) store.set(key, { uri: doc.uri, version: doc.version, result });
  else store.delete(key);
  selection.prune(key, result.findings);
  preview.refresh(doc);

  const severityName = cfg(doc.uri).get('diagnosticSeverity', 'information');
  const forced = severityName === 'auto' ? null : SEVERITY[severityName];

  // ATC findings without a rule are already in the Problems panel (from ADT); they are only listed in the sidebar
  const diags = result.findings.filter((f) => f.ruleId !== 'atc').map((f) => {
    // The line ATC reports (inside the statement) for ATC findings, otherwise the statement start
    const line = Math.min(f.line != null ? f.line : f.startLine, doc.lineCount - 1);
    const text = doc.lineAt(line).text;
    const col = line === f.startLine ? Math.min(f.startCol, text.length) : text.search(/\S|$/);
    const range = new vscode.Range(line, col, line, text.length);
    const d = new vscode.Diagnostic(
      range,
      diagMessage(f),
      forced != null ? forced : SEVERITY[f.severity] || SEVERITY.information
    );
    d.source = 'SmartFix for ABAP';
    d.code = f.ruleId;
    return d;
  });
  diagnostics.set(doc.uri, diags);

  provider.refresh();
  updateStatusBar();
  prefetchDdic(doc);
  return result;
}

/** Stored findings for the document, analyzed again when the text changed since the last scan */
function freshEntry(doc) {
  const e = store.get(doc.uri.toString());
  if (e && e.version === doc.version) return e;
  scanDocument(doc);
  return store.get(doc.uri.toString());
}

function updateStatusBar() {
  let total = 0;
  for (const [, e] of store) total += e.result.findings.length;
  if (!total) {
    statusBar.hide();
    return;
  }
  const atcOn = atc.switchedOn();
  const variant = atc.variant().name;
  statusBar.text = '$(wand) SmartFix for ABAP ' + total + (atcOn ? ' · ATC $(check)' + (variant ? ' ' + variant : '') : '');
  statusBar.tooltip = total + ' finding' + (total === 1 ? '' : 's') + ' (code rewrites or Pragma / Pseudo Comment). ' +
    (atcOn ? 'ATC results from ADT: on (check variant ' + (variant || 'DEFAULT') + '). ' : 'ATC results from ADT: off (decided from the source). ') +
    'Click to show the list.';
  statusBar.show();
}

/** Show whether ATC results from ADT are used: sidebar title and status bar */
function showAtcState() {
  const on = atc.switchedOn();
  const variant = atc.variant().name;
  if (findingsView) findingsView.description = on ? 'ATC: On' + (variant ? ' (' + variant + ')' : '') : '';
  updateStatusBar();
}

/** Ask for the ATC check variant (abap-smartfix.atc.checkVariant); DEFAULT is the system's default check variant */
async function selectAtcVariant() {
  const value = await vscode.window.showInputBox({
    title: 'SmartFix for ABAP: ATC Check Variant',
    prompt: 'Check variant ATC runs with. DEFAULT (or empty) uses the system\'s default check variant, as ADT\'s "Run ABAP Test Cockpit".',
    value: cfg().get('atc.checkVariant', 'DEFAULT') || 'DEFAULT',
    validateInput: (v) => Atc.checkVariantOf(v).error || null,
  });
  if (value === undefined) return;
  const name = Atc.checkVariantOf(value).name || 'DEFAULT';
  await cfg().update('atc.checkVariant', name, vscode.ConfigurationTarget.Global);
  showAtcState();
  vscode.window.showInformationMessage('SmartFix for ABAP: ATC check variant ' + name +
    '. Takes effect the next time you run Analyze / Auto Fix / Preview.');
}

/** Turn the use of ATC results on or off; the findings shown stay until the next Analyze */
async function setAtc(on) {
  await cfg().update('atc.enabled', on, vscode.ConfigurationTarget.Global);
  showAtcState();
  vscode.window.showInformationMessage(on
    ? 'SmartFix for ABAP: ATC results from ADT ON. Takes effect the next time you run Analyze / Auto Fix / Preview.'
    : 'SmartFix for ABAP: ATC results from ADT OFF. Takes effect the next time you run Analyze.');
}

function clearAll() {
  store.clear();
  selection.clear();
  for (const key of [...tracked]) untrack(key);
  diagnostics.clear();
  provider.refresh();
  updateStatusBar();
}

/** Stop analyzing the file while typing */
function untrack(key) {
  tracked.delete(key);
  atc.forget(key);
  analysisCache.delete(key);
  lastAnalysisMs.delete(key);
  clearTimeout(typingTimers.get(key));
  typingTimers.delete(key);
}

/** Analyze again once typing pauses, so the sidebar and Problems panel follow the current text */
function onDocumentChanged(e) {
  const doc = e.document;
  const key = doc.uri.toString();
  if (!e.contentChanges.length) return;
  atc.trackChanges(key, e.contentChanges);
  if (!tracked.has(key)) return;
  if (!cfg(doc.uri).get('scanOnType', true)) return;
  clearTimeout(typingTimers.get(key));
  typingTimers.set(
    key,
    setTimeout(() => {
      typingTimers.delete(key);
      if (doc.isClosed || !tracked.has(key)) return;
      const e = store.get(key);
      if (!e || e.version !== doc.version) scanDocument(doc);
    // A large program takes seconds to analyze: wait longer, so typing is not interrupted by analyses
    }, Math.max(TYPING_DELAY_MS, 3 * (lastAnalysisMs.get(key) || 0)))
  );
}

/** URIs shown by a tab: the file of a text tab, or both sides of a diff tab */
function tabUris(tab) {
  const i = tab && tab.input;
  if (!i) return [];
  return [i.uri, i.original, i.modified].filter(Boolean).map((u) => u.toString());
}

/** When the last tab showing a file is closed, remove its findings from the sidebar and Problems panel */
function onTabsClosed(closed) {
  const open = new Set();
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) tabUris(t).forEach((u) => open.add(u));
  let changed = false;
  for (const key of new Set(closed.flatMap(tabUris))) {
    if (open.has(key)) continue;
    preview.forget(key);
    untrack(key);
    selection.forget(key);
    const entry = store.get(key);
    if (!entry) continue;
    store.delete(key);
    diagnostics.delete(entry.uri);
    changed = true;
  }
  if (changed) {
    provider.refresh();
    updateStatusBar();
  }
}

// ---------------------------------------------------------------- applying fixes

/**
 * Pick the findings a fix applies to:
 *   { all: true }           every finding that is checked in the sidebar
 *   { keys: [...] }         exactly these findings (a sidebar item, or the ones picked for an editor selection)
 *   { line, ruleIds }       the findings of one statement (Quick Fix)
 */
function filterFindings(uri, findings, selector) {
  if (!selector) return findings;
  if (selector.keys) {
    const keys = new Set(selector.keys);
    return findings.filter((f) => keys.has(f.key));
  }
  if (selector.all) return selection.checkedOf(uri, findings);
  return findings.filter((f) => {
    if (selector.line != null && !(f.startLine <= selector.line && selector.line <= f.endLine)) {
      return false;
    }
    if (selector.ruleIds && selector.ruleIds.indexOf(f.ruleId) < 0) return false;
    return true;
  });
}

/**
 * Objects from the SAP system that are not customer objects (Z* / Y*) are not changed:
 * a change to an SAP object is a modification. Returns the reason, or '' for customer objects and local files.
 */
function notCustomerObject(doc) {
  if (doc.uri.scheme !== 'abap') return '';
  const file = doc.uri.path.split('/').pop() || '';
  const name = file.split('.')[0].replace(/^\(([^)]+)\)/, '/$1/').toUpperCase();
  if (!name || /^[ZY]/.test(name)) return '';
  return name + ' is not a customer object (Z* / Y*); SmartFix for ABAP does not change SAP objects';
}

/** Analyze and plan edits for the selector; selector.mode can force rewrite / suppress */
function planFor(doc, selector) {
  const opts = optionsFor(doc.uri, selector && selector.mode);
  const text = doc.getText();
  const result = analyzeDoc(doc, opts);
  const picked = filterFindings(doc.uri.toString(), result.findings, selector);
  // Self-check: every rewrite is applied in memory and analyzed again before it may touch the file
  if (cfg(doc.uri).get('verifyFixes', true)) {
    // The same rewrites of the same version were checked already (scan, preview and fix of one command): reuse the answer
    const vkey = picked.filter((f) => f.action === 'rewrite').map((f) => f.key).sort().join('\u0002');
    const verified = result.cache ? result.cache.verified : new Map();
    let rejected = verified.get(vkey);
    if (!rejected) {
      rejected = verifyRewrites(text, result, picked, (t) => analyze(t, opts));
      verified.set(vkey, rejected);
      for (const [key, why] of rejected) log('Rewrite rejected by the self-check (' + why + '): ' + key.split('\u0001').slice(0, 2).join(' | '));
    }
    if (rejected.size) downgradeRejected(picked, rejected);
  }
  const blocked = notCustomerObject(doc);
  const plan = blocked
    ? { edits: [], actions: [], unfixable: picked.length ? [{ findings: picked, reason: blocked }] : [] }
    : planEdits(result.lines, result.comments, picked);
  const skipped = selector && selector.all ? result.findings.length - picked.length : 0;
  return { result, picked, plan, skipped };
}

function clampPos(doc, line, col) {
  const l = Math.min(line, doc.lineCount - 1);
  return new vscode.Position(l, Math.min(col, doc.lineAt(l).text.length));
}

/** Add the plan's edits to a WorkspaceEdit (using the document's own line breaks) */
function addPlanEdits(edit, doc, plan) {
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  for (const e of plan.edits) {
    const text = e.text.replace(/\n/g, eol);
    const start = clampPos(doc, e.line, e.col);
    if (e.endLine === e.line && e.endCol === e.col) edit.insert(doc.uri, start, text);
    else edit.replace(doc.uri, new vscode.Range(start, clampPos(doc, e.endLine, e.endCol)), text);
  }
}

/** Count the results of one or more plans: { rewritten, suppressed, manual } */
function tally(...plans) {
  const t = { rewritten: 0, suppressed: 0, manual: 0 };
  for (const plan of plans) {
    for (const a of plan.actions) {
      if (a.type === 'rewrite') t.rewritten += a.findings.length;
      else t.suppressed += a.findings.length;
    }
    for (const u of plan.unfixable) t.manual += u.findings.length;
  }
  return t;
}

function logUnfixable(doc, plan) {
  for (const u of plan.unfixable) {
    log('Manual fix needed: ' + vscode.workspace.asRelativePath(doc.uri) + ' line ' + (u.findings[0].startLine + 1) +
      ' [' + u.findings.map((f) => f.ruleId).join(', ') + ']: ' + u.reason);
  }
}

/** Message after applying fixes; opens the output panel when manual items remain */
function reportApplied(t) {
  const applied = t.rewritten + t.suppressed;
  const summary = 'Fixed ' + applied + ' finding' + (applied === 1 ? '' : 's') + ' (' + t.rewritten + ' rewritten, ' + t.suppressed + ' annotated)';
  if (t.manual) {
    vscode.window.showWarningMessage(summary + '; ' + t.manual + ' need manual fixing (see the Output panel).');
    if (output) output.show(true);
  } else {
    vscode.window.showInformationMessage(summary + '.');
  }
  return applied;
}

async function applyFindings(uri, selector) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const { picked, plan } = planFor(doc, selector);
  if (!picked.length) {
    vscode.window.showInformationMessage('Nothing to fix.');
    return 0;
  }

  if (plan.edits.length) {
    const edit = new vscode.WorkspaceEdit();
    addPlanEdits(edit, doc, plan);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      vscode.window.showErrorMessage('Failed to apply the fixes. The file may have been changed by another process.');
      return 0;
    }
  }

  logUnfixable(doc, plan);
  const applied = reportApplied(tally(plan));
  // The fixes are checked by ATC once they are in the system
  // One ATC run after the fix: offered, not started, since saving writes the fixed code to the SAP system
  if (applied && atc.enabled(doc)) {
    log('ATC: ' + applied + ' fixes applied to ' + doc.fileName + '. Save (it goes to the SAP system), then ATC checks the fixed code.');
    vscode.window.showInformationMessage('SmartFix for ABAP: save the fixed file and re-check it with ATC?', SAVE_AND_RUN).then(async (pick) => {
      if (pick !== SAVE_AND_RUN || doc.isClosed) return;
      if (doc.isDirty && !(await doc.save())) return;
      await atc.run(doc);
      scanDocument(doc);
    });
  }
  scanDocument(await vscode.workspace.openTextDocument(uri));
  return applied;
}

/**
 * Fix every file in the scan results at once (a single WorkspaceEdit, so one undo reverts it).
 * Modified files are not saved automatically.
 */
async function applyWorkspace(mode) {
  const uris = [...store.values()].map((e) => e.uri);
  if (!uris.length) {
    vscode.window.showInformationMessage('No scan results yet. Run "SmartFix for ABAP: Analyze Workspace" first.');
    return 0;
  }

  const plans = [];
  let skipped = 0;
  for (const uri of uris) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await atc.ensure(doc);
      const p = planFor(doc, { all: true, mode });
      skipped += p.skipped;
      if (p.picked.length) plans.push({ doc, plan: p.plan });
    } catch (e) {
      log('Skipped ' + uri.fsPath + ': ' + e.message);
    }
  }
  const total = tally(...plans.map((p) => p.plan));
  if (!total.rewritten && !total.suppressed) {
    vscode.window.showInformationMessage('Nothing can be fixed automatically' + (total.manual ? ' (' + total.manual + ' need manual fixing)' : '') + skippedNote(skipped) + '.');
    return 0;
  }

  const pick = await vscode.window.showWarningMessage(
    'This will modify ' + plans.length + ' file' + (plans.length === 1 ? '' : 's') + ': ' + total.rewritten + ' rewrites, ' + total.suppressed + ' annotations' +
      (total.manual ? '; ' + total.manual + ' need manual fixing' : '') + skippedNote(skipped) +
      '. Files will not be saved automatically. Continue?',
    { modal: true },
    APPLY
  );
  if (pick !== APPLY) return 0;

  const edit = new vscode.WorkspaceEdit();
  for (const p of plans) addPlanEdits(edit, p.doc, p.plan);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage('Failed to apply the fixes. A file may have been changed by another process.');
    return 0;
  }

  for (const p of plans) {
    logUnfixable(p.doc, p.plan);
    scanDocument(await vscode.workspace.openTextDocument(p.doc.uri));
  }
  return reportApplied(total);
}

const APPLY = 'Apply';
const PREVIEW = 'Preview Diff';

function skippedNote(skipped) {
  return skipped ? '; ' + skipped + ' unchecked in the sidebar ' + (skipped === 1 ? 'is' : 'are') + ' skipped' : '';
}

/** Show what will be fixed and ask for confirmation; the diff can be previewed first */
async function confirmAndApply(doc, mode) {
  await atc.ensure(doc);
  scanDocument(doc);
  const blocked = notCustomerObject(doc);
  if (blocked) {
    vscode.window.showWarningMessage('SmartFix for ABAP: ' + blocked + '.');
    return 0;
  }
  const { picked, plan, skipped } = planFor(doc, { all: true, mode });
  if (!picked.length) {
    vscode.window.showInformationMessage(skipped ? 'Nothing to fix: all findings are unchecked in the sidebar.' : 'Nothing to fix.');
    return 0;
  }
  const n = countActions(picked);
  const manual = tally(plan).manual;
  const pick = await vscode.window.showWarningMessage(
    'This will modify the file: ' + n.rewrite + ' rewrites, ' + n.suppress + ' annotations' +
      (manual ? '; ' + manual + ' need manual fixing' : '') + skippedNote(skipped) + '. Continue?',
    { modal: true },
    APPLY,
    PREVIEW
  );
  if (pick === PREVIEW) {
    if ((await previewFix(doc, mode)) == null) return 0;
    const again = await vscode.window.showInformationMessage('Apply the fixes shown in the diff?', APPLY);
    if (again !== APPLY) return 0;
  } else if (pick !== APPLY) {
    return 0;
  }
  return applyFindings(doc.uri, { all: true, mode });
}

// ---------------------------------------------------------------- diff preview (preview.js)

/** @type {Preview} */
let preview;

/** Open a diff of the current content against the auto-fixed content, without touching the file */
async function previewFix(doc, mode) {
  scanDocument(doc);
  return preview.open(doc, mode, false);
}

// ---------------------------------------------------------------- Quick Fix

/**
 * Auto fix on save: add this to settings.json
 *   "editor.codeActionsOnSave": { "source.fixAll.abap-smartfix": "explicit" }
 * Fixes the whole file according to abap-smartfix.fixMode; no prior scan and no confirmation dialog.
 */
function fixAllAction(doc) {
  const { picked, plan } = planFor(doc, { all: true });
  if (!picked.length || !plan.edits.length) return [];
  const edit = new vscode.WorkspaceEdit();
  addPlanEdits(edit, doc, plan);
  const t = tally(plan);
  const a = new vscode.CodeAction(
    'SmartFix for ABAP: Fix whole file (' + t.rewritten + ' rewrites, ' + t.suppressed + ' annotations)',
    FIX_ALL_KIND
  );
  a.edit = edit;
  return [a];
}

class SmartFixCodeActionProvider {
  provideCodeActions(doc, range, context) {
    if (context && context.only && context.only.intersects(FIX_ALL_KIND)) return fixAllAction(doc);

    // Only files that were analyzed; re-analyze after edits so line numbers match the current text
    if (!store.has(doc.uri.toString())) return [];
    const entry = freshEntry(doc);
    if (!entry) return [];

    const line = range.start.line;
    const here = entry.result.findings.filter((f) => f.startLine <= line && line <= f.endLine);
    const actions = [];

    const push = (title, sel, preferred) => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { command: 'abap-smartfix.applyFindings', title, arguments: [doc.uri, sel] };
      if (preferred) a.isPreferred = true;
      actions.push(a);
    };

    // Offer both "rewrite code" and "add annotation" for each finding, default action first
    for (const f of here) {
      const sel = { line: f.startLine, ruleIds: [f.ruleId] };
      const rewriteFirst = f.action === 'rewrite';
      const items = [];
      if (f.rewrite) {
        const tag = f.rewrite.safety === 'review' ? ' (changes behavior, please review)' : '';
        items.push({ title: 'Rewrite: ' + f.rewrite.summary + tag, sel: Object.assign({ mode: 'rewrite' }, sel) });
      }
      if (f.canSuppress) {
        items.push({ title: 'Add ' + f.token, sel: Object.assign({ mode: 'suppress' }, sel) });
      }
      if (!rewriteFirst) items.reverse();
      items.forEach((it, i) => push(it.title, it.sel, i === 0 && f.action !== 'manual' && here.length === 1));
    }

    // A selection over several lines: choose which of its findings to fix
    const lastLine = lastSelectedLine(range.start, range.end);
    if (lastLine > line) {
      const inSel = findingsInLines(entry.result.findings, line, lastLine);
      if (inSel.length) {
        const a = new vscode.CodeAction('Fix findings in selection… (' + inSel.length + ')', vscode.CodeActionKind.QuickFix);
        a.command = { command: 'abap-smartfix.fixSelection', title: 'Fix findings in selection', arguments: [doc.uri, line, lastLine] };
        actions.push(a);
      }
    }

    if (here.length > 1) {
      const a = new vscode.CodeAction(
        'Fix all findings in this statement (' + here.length + ')',
        vscode.CodeActionKind.QuickFix
      );
      a.command = {
        command: 'abap-smartfix.applyFindings',
        title: 'Fix all',
        arguments: [doc.uri, { line: here[0].startLine }],
      };
      actions.push(a);
    }

    // Counts only the findings checked in the sidebar, the ones { all: true } will fix
    const checked = selection.checkedOf(doc.uri.toString(), entry.result.findings);
    if (checked.length) {
      const n = countActions(checked);
      const a = new vscode.CodeAction(
        'Auto fix whole file (' + n.rewrite + ' rewrites, ' + n.suppress + ' annotations)',
        vscode.CodeActionKind.Source
      );
      a.command = {
        command: 'abap-smartfix.applyFindings',
        title: 'Auto fix whole file',
        arguments: [doc.uri, { all: true }],
      };
      actions.push(a);
    }

    return actions;
  }
}

// ---------------------------------------------------------------- choosing findings

/** Last line of a selection: one that ends at the start of a line does not include that line */
function lastSelectedLine(start, end) {
  return end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
}

function findingsInLines(findings, fromLine, toLine) {
  return findings.filter((f) => f.startLine <= toLine && f.endLine >= fromLine);
}

/**
 * Fix findings in the selected lines: list them (checked as in the sidebar) and fix the ones the user keeps picked.
 * Without arguments the active editor's selection is used (the cursor line when nothing is selected).
 */
async function fixSelection(uri, fromLine, toLine) {
  let doc;
  // Quick Fix passes (uri, fromLine, toLine); the editor context menu passes only the file uri
  if (uri && typeof fromLine === 'number' && typeof toLine === 'number') {
    doc = await vscode.workspace.openTextDocument(uri);
  } else {
    const key = uri && uri.scheme ? uri.toString() : null;
    const active = vscode.window.activeTextEditor;
    const ed =
      key && !(active && active.document.uri.toString() === key)
        ? (vscode.window.visibleTextEditors || []).find((e) => e.document.uri.toString() === key)
        : active;
    if (!ed || !isAbapDoc(ed.document)) {
      vscode.window.showWarningMessage('Please select code in an ABAP file first.');
      return 0;
    }
    doc = ed.document;
    const sel = ed.selection;
    fromLine = sel.start.line;
    toLine = lastSelectedLine(sel.start, sel.end);
  }
  await atc.ensure(doc);
  scanDocument(doc);
  const entry = freshEntry(doc);
  const inSel = entry ? findingsInLines(entry.result.findings, fromLine, toLine) : [];
  if (!inSel.length) {
    vscode.window.showInformationMessage('No findings in the selected lines.');
    return 0;
  }
  const key = doc.uri.toString();
  const items = inSel.map((f) => ({
    label: 'L' + ((f.line != null ? f.line : f.startLine) + 1) + '  ' + f.fixLabel,
    description: f.title,
    detail: f.snippet,
    picked: selection.isChecked(key, f.key),
    key: f.key,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Fix findings in lines ' + (fromLine + 1) + '–' + (toLine + 1),
    placeHolder: 'Keep the findings to fix checked, then press Enter',
  });
  if (!picked || !picked.length) return 0;
  return applyFindings(doc.uri, { keys: picked.map((p) => p.key) });
}

/** Sidebar checkbox changes; checking a file checks all of its findings */
function onCheckboxChanged(e) {
  const checkedState = vscode.TreeItemCheckboxState.Checked;
  // If one event carries a finding together with its file node, the finding is what was clicked
  const findingFiles = new Set(e.items.filter(([item]) => item.kind === 'finding').map(([item]) => item.uriString));
  for (const [item, state] of e.items) {
    if (item.kind === 'file' && findingFiles.has(item.uriString)) continue;
    const entry = store.get(item.uriString);
    if (!entry) continue;
    if (item.kind === 'file') selection.setAll(item.uriString, entry.result.findings, state === checkedState);
    else if (item.kind === 'finding') selection.set(item.uriString, item.finding.key, state === checkedState);
  }
  provider.refresh();
  refreshPreviewsOf(new Set(e.items.map(([item]) => item.uriString)));
}

function setAllChecked(checked) {
  for (const [key, entry] of store) selection.setAll(key, entry.result.findings, checked);
  provider.refresh();
  refreshPreviewsOf(new Set(store.keys()));
}

/** Previews only show checked findings, so recompute open previews of files whose checkboxes changed */
function refreshPreviewsOf(keys) {
  for (const doc of vscode.workspace.textDocuments || []) if (keys.has(doc.uri.toString())) preview.refresh(doc);
}

// ---------------------------------------------------------------- annotation names: learning

/**
 * Read every ABAP file of the workspace, learn which annotation names the code already uses for each rule,
 * and offer them as abap-smartfix.tokenOverrides.
 */
async function learnFromWorkspace() {
  const conf = cfg();
  const uris = await vscode.workspace.findFiles(conf.get('include', '**/*.abap'), conf.get('exclude', '**/node_modules/**'), conf.get('maxFiles', 500));
  if (!uris.length) {
    vscode.window.showInformationMessage('No ABAP files found in the workspace.');
    return;
  }
  const files = [];
  for (const uri of uris) {
    try {
      files.push({ path: vscode.workspace.asRelativePath(uri), text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') });
    } catch (e) {
      log('Skipped ' + uri.fsPath + ': ' + e.message);
    }
  }
  const learned = learnAnnotations(files, readOptions());
  const items = learned.suggestions
    .map((s) => ({
      label: s.ruleId + ' → ' + s.token,
      description: s.votes + ' of ' + s.of + ' annotated statements use it',
      detail: 'e.g. ' + s.example,
      picked: true,
      learned: s,
    }));
  if (!items.length) {
    vscode.window.showInformationMessage(
      'Looked at ' + files.length + ' files (' + learned.statements + ' annotated statements): the annotations in use already match the rules.'
    );
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Annotation names used in this workspace (' + files.length + ' files)',
    placeHolder: 'Checked ones are saved to abap-smartfix.tokenOverrides (workspace settings)',
  });
  if (!chosen || !chosen.length) return;
  const overrides = Object.assign({}, conf.get('tokenOverrides', {}));
  for (const c of chosen) overrides[c.learned.ruleId] = c.learned.token;
  await conf.update('tokenOverrides', overrides, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('Saved ' + chosen.length + ' annotation name' + (chosen.length === 1 ? '' : 's') + ' to abap-smartfix.tokenOverrides.');
}

// ---------------------------------------------------------------- collecting data

function entriesForPrompt(onlyUri) {
  const list = [];
  for (const [, e] of store) {
    if (onlyUri && e.uri.toString() !== onlyUri.toString()) continue;
    list.push({ path: vscode.workspace.asRelativePath(e.uri), result: e.result });
  }
  return list;
}

async function openVirtualDoc(content, language) {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

async function ensureScanned(doc) {
  return freshEntry(doc);
}

/** Show the SmartFix for ABAP sidebar with the findings, then give the keyboard focus back to the editor */
async function showSidebar() {
  try {
    await vscode.commands.executeCommand('abap-smartfix.findings.focus');
    if (vscode.window.activeTextEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  } catch (e) {
    log('Could not show the sidebar: ' + (e && e.message ? e.message : e));
  }
}

async function scanWorkspace() {
  const conf = cfg();
  const include = conf.get('include', '**/*.abap');
  const exclude = conf.get('exclude', '**/node_modules/**');
  const max = conf.get('maxFiles', 500);

  const uris = await vscode.workspace.findFiles(include, exclude, max);
  if (!uris.length) {
    vscode.window.showInformationMessage('No files match ' + include + '.');
    return;
  }

  clearAll();
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Analyzing ABAP files…', cancellable: true },
    async (progress, token) => {
      for (let i = 0; i < uris.length; i++) {
        if (token.isCancellationRequested) break;
        progress.report({
          message: i + 1 + '/' + uris.length + '  ' + path.basename(uris[i].fsPath),
          increment: 100 / uris.length,
        });
        try {
          const doc = await vscode.workspace.openTextDocument(uris[i]);
          scanDocument(doc);
        } catch (e) {
          log('Skipped ' + uris[i].fsPath + ': ' + e.message);
        }
      }
    }
  );

  let total = 0;
  for (const [, e] of store) total += e.result.findings.length;
  vscode.window.showInformationMessage(
    'Analysis complete: ' + uris.length + ' files scanned, ' + total + ' findings in ' + store.size + ' files.'
  );
}

// ---------------------------------------------------------------- activate

function activate(context) {
  output = vscode.window.createOutputChannel('SmartFix for ABAP');
  preview = new Preview({
    plan: (doc, mode) => planFor(doc, { all: true, mode }),
    logUnfixable,
    showOutput: () => output.show(true),
    cfg,
    log,
  });
  atc = new AtcRunner({
    cfg,
    log,
    globalState: context.globalState,
    analyze: (doc) => analyzeText(doc, readOptions(doc.uri)),
    preview,
  });
  diagnostics = vscode.languages.createDiagnosticCollection('abap-smartfix');
  provider = new FindingsProvider(store, selection);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'abap-smartfix.focusView';

  // Manual checkbox state: otherwise VS Code also unchecks the file node when one finding is unchecked,
  // and that file change would uncheck every finding of the file
  const treeView = vscode.window.createTreeView('abap-smartfix.findings', {
    treeDataProvider: provider,
    manageCheckboxStateManually: true,
  });
  if (treeView.onDidChangeCheckboxState) context.subscriptions.push(treeView.onDidChangeCheckboxState(onCheckboxChanged));
  findingsView = treeView;
  showAtcState();

  const selector = [
    { language: 'abap' },
    { scheme: 'file', pattern: '**/*.abap' },
  ];

  // Get the ABAP document being edited; if it is not ABAP, ask the user before continuing
  const activeAbapDoc = async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showWarningMessage('Please open an ABAP file first.');
      return null;
    }
    // In the diff preview the focus can be on the preview side: work on the file it previews
    const previewed = preview.sourceOf(ed.document.uri);
    if (previewed) {
      const source = vscode.workspace.textDocuments.find((d) => d.uri.toString() === previewed);
      return source || vscode.workspace.openTextDocument(vscode.Uri.parse(previewed));
    }
    if (isAbapDoc(ed.document)) return ed.document;
    const pick = await vscode.window.showWarningMessage(
      'This file is not recognized as ABAP. Analyze it as ABAP anyway?',
      { modal: true },
      'Analyze Anyway'
    );
    return pick === 'Analyze Anyway' ? ed.document : null;
  };

  context.subscriptions.push(
    output,
    diagnostics,
    statusBar,
    treeView,

    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),

    vscode.languages.registerCodeActionsProvider(selector, new SmartFixCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Source, FIX_ALL_KIND],
    }),

    // Only files that were analyzed; re-analyzed after edits so line numbers match the current text
    vscode.languages.registerHoverProvider(selector, new FindingHoverProvider({
      entryFor: (doc) => (store.has(doc.uri.toString()) ? freshEntry(doc) : undefined),
      cfg,
    })),

    vscode.commands.registerCommand('abap-smartfix.scanFile', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await atc.run(doc);
      const result = scanDocument(doc);
      await showSidebar();
      const n = countActions(result.findings);
      vscode.window.showInformationMessage(
        result.findings.length
          ? 'Found ' + result.findings.length + ' finding' + (result.findings.length === 1 ? '' : 's') + ': ' + n.rewrite +
              ' auto-fixable, ' + n.suppress + ' to annotate, ' + n.manual + ' manual.'
          : 'No findings.'
      );
    }),

    vscode.commands.registerCommand('abap-smartfix.scanWorkspace', scanWorkspace),

    vscode.commands.registerCommand('abap-smartfix.applyFindings', (uri, sel) => applyFindings(uri, sel)),

    vscode.commands.registerCommand('abap-smartfix.applyAll', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await atc.run(doc);
      await showSidebar();
      await confirmAndApply(doc, null);
    }),

    vscode.commands.registerCommand('abap-smartfix.applySuppressOnly', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await atc.run(doc);
      await showSidebar();
      await confirmAndApply(doc, 'suppress');
    }),

    vscode.commands.registerCommand('abap-smartfix.previewFix', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await atc.run(doc);
      await showSidebar();
      await previewFix(doc, null);
    }),

    vscode.commands.registerCommand('abap-smartfix.applyFile', async (node) => {
      const uri = node && node.resourceUri ? node.resourceUri : null;
      if (uri) await confirmAndApply(await vscode.workspace.openTextDocument(uri), null);
    }),

    vscode.commands.registerCommand('abap-smartfix.applyWorkspace', () => applyWorkspace(null)),

    vscode.commands.registerCommand('abap-smartfix.copyAiPrompt', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await ensureScanned(doc);
      await showSidebar();
      const files = entriesForPrompt(doc.uri);
      if (!files.length) {
        vscode.window.showInformationMessage('This file has no findings.');
        return;
      }
      const text = buildAiPrompt(files, {
        includeSource: cfg(doc.uri).get('promptIncludeSource', true),
      });
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('AI prompt copied to the clipboard. Paste it into your AI assistant.');
    }),

    vscode.commands.registerCommand('abap-smartfix.showAiPrompt', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await ensureScanned(doc);
      const files = entriesForPrompt(doc.uri);
      if (!files.length) {
        vscode.window.showInformationMessage('This file has no findings.');
        return;
      }
      await openVirtualDoc(
        buildAiPrompt(files, { includeSource: cfg(doc.uri).get('promptIncludeSource', true) }),
        'markdown'
      );
    }),

    vscode.commands.registerCommand('abap-smartfix.copyAiPromptWorkspace', async () => {
      const files = entriesForPrompt(null);
      if (!files.length) {
        vscode.window.showInformationMessage('No scan results yet. Run "SmartFix for ABAP: Analyze Workspace" first.');
        return;
      }
      const text = buildAiPrompt(files, { includeSource: cfg().get('promptIncludeSource', true) });
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        'AI prompt for ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' copied to the clipboard.'
      );
    }),

    vscode.commands.registerCommand('abap-smartfix.showReport', async () => {
      const files = entriesForPrompt(null);
      if (!files.length) {
        vscode.window.showInformationMessage('No scan results yet.');
        return;
      }
      await openVirtualDoc(buildReport(files), 'markdown');
    }),

    vscode.commands.registerCommand('abap-smartfix.listRules', async () => {
      const opts = readOptions(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      const items = describeRules(opts).map((d) => {
        const r = d.rule;
        const fixes = [r.fix ? 'rewrite' : '', d.token ? 'annotation' : ''].filter(Boolean).join(' / ');
        const status = d.token ? (d.source === 'setting' ? 'from tokenOverrides' : 'annotation') : 'no annotation';
        return {
          label: (d.enabled ? '$(check) ' : '$(circle-slash) ') + (d.token || r.id),
          description: r.id + ' · ' + status + (r.sci && r.sci.classes && r.sci.classes.length ? ' · ' + r.sci.classes.join(', ') : ''),
          detail: '[' + fixes + '] ' + r.title + ' — ' + r.why,
        };
      });
      await vscode.window.showQuickPick(items, {
        title: 'Rules (adjust with the abap-smartfix.disabledRules / enabledRules settings)',
        matchOnDetail: true,
      });
    }),

    vscode.commands.registerCommand('abap-smartfix.reveal', async (uri, line, col) => {
      // Show the original and the preview together: the open diff preview of the file, or a new one when there are
      // automatic changes; the line is selected on the original (left) side and the preview side scrolls with it
      const key = uri.toString();
      let diffTab = await preview.showDiff(key);
      if (!diffTab && cfg(uri).get('preview.onReveal', true) && store.has(key)) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (await preview.open(doc, null, true)) diffTab = preview.findTab(key);
        } catch (e) {
          log('Preview could not be opened: ' + (e && e.message ? e.message : e));
        }
      }
      let editor = diffTab ? await preview.originalSideOf(key, diffTab) : null;
      if (!editor) {
        const active = vscode.window.activeTextEditor;
        const visible = vscode.window.visibleTextEditors || [];
        editor = active && active.document.uri.toString() === key ? active : visible.find((e) => e.document.uri.toString() === key);
      }
      if (!editor) {
        const doc = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(doc, { preview: true });
      }
      const l = Math.min(line, editor.document.lineCount - 1);
      const pos = new vscode.Position(l, col != null ? col : editor.document.lineAt(l).firstNonWhitespaceCharacterIndex);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),

    vscode.commands.registerCommand('abap-smartfix.focusView', () =>
      vscode.commands.executeCommand('abap-smartfix.findings.focus')
    ),

    vscode.commands.registerCommand('abap-smartfix.fixFinding', async (node) => {
      const entry = node && node.finding ? store.get(node.uriString) : null;
      if (!entry) return;
      const doc = await vscode.workspace.openTextDocument(entry.uri);
      // A finding listed before ATC was run: run it now, the finding may turn out not to be reported by ATC
      if (atc.switchedOn(doc.uri) && !atc.state(entry.uri.toString())) {
        await atc.run(doc);
        scanDocument(doc);
      }
      await applyFindings(entry.uri, { keys: [node.finding.key] });
    }),

    vscode.commands.registerCommand('abap-smartfix.fixSelection', async (uri, fromLine, toLine) => {
      await showSidebar();
      await fixSelection(uri, fromLine, toLine);
    }),

    vscode.commands.registerCommand('abap-smartfix.checkAll', () => setAllChecked(true)),

    vscode.commands.registerCommand('abap-smartfix.uncheckAll', () => setAllChecked(false)),

    vscode.commands.registerCommand('abap-smartfix.learnAnnotations', learnFromWorkspace),

    vscode.commands.registerCommand('abap-smartfix.clear', clearAll),

    vscode.commands.registerCommand('abap-smartfix.toggleAtc', () => setAtc(!atc.switchedOn())),
    vscode.commands.registerCommand('abap-smartfix.atcOn', () => setAtc(true)),
    vscode.commands.registerCommand('abap-smartfix.atcOff', () => setAtc(false)),
    vscode.commands.registerCommand('abap-smartfix.selectAtcVariant', selectAtcVariant),

    vscode.commands.registerCommand('abap-smartfix.clearDdicCache', () => {
      DdicAdt.clearCache();
      log('DDIC cache cleared.');
      for (const [key] of [...store]) {
        const entry = store.get(key);
        vscode.workspace.openTextDocument(entry.uri).then(scanDocument, () => {});
      }
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (cfg(doc.uri).get('scanOnSave', true) && isAbapDoc(doc)) scanDocument(doc);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (cfg(doc.uri).get('scanOnOpen', false) && isAbapDoc(doc)) scanDocument(doc);
    }),

    vscode.workspace.onDidChangeTextDocument(onDocumentChanged),

    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.closed.length) onTabsClosed(e.closed);
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.isUntitled) {
        untrack(doc.uri.toString());
        store.delete(doc.uri.toString());
        diagnostics.delete(doc.uri);
        provider.refresh();
        updateStatusBar();
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('abap-smartfix')) return;
      // Switching ATC on / off only takes effect with the next Analyze
      if (e.affectsConfiguration('abap-smartfix.atc.enabled')) {
        showAtcState();
        return;
      }
      // So does the check variant; the findings do not change before ATC runs again
      if (e.affectsConfiguration('abap-smartfix.atc.checkVariant') || e.affectsConfiguration('abap-smartfix.atc.checkVariantDelay')) {
        showAtcState();
        return;
      }
      for (const [key] of [...store]) {
        const entry = store.get(key);
        vscode.workspace.openTextDocument(entry.uri).then(scanDocument, () => {});
      }
    })
  );

  log('SmartFix for ABAP activated.');
}

function deactivate() {
  for (const key of [...tracked]) untrack(key);
  store.clear();
}

module.exports = { activate, deactivate };
