'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { analyze, describeRules } = require('./analyzer');
const { planEdits, applyEditsToText } = require('./fixer');
const { verifyRewrites, downgradeRejected } = require('./verify');
const { learnAnnotations } = require('./learn');
const { buildAiPrompt, buildReport } = require('./report');
const { FindingsProvider } = require('./view');
const { Selection } = require('./selection');
const { ddicRequests } = require('./ddic');
const DdicAdt = require('./ddic-adt');
const Atc = require('./atc');

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
    bufferedTables: bufferedTables(uri),
  };
}

// ---------------------------------------------------------------- what ATC told about the system

const FACTS_KEY = 'abap-smartfix.atcFacts';
let extContext = null;

/** Destination of a document for remembered ATC facts: its ADT destination, or the configured one */
function factsDestination(uri) {
  return String(DdicAdt.destinationOf(uri, cfg(uri).get('ddic.destination', '')) || '').toUpperCase();
}

/** Buffered tables: the ones ATC reported for this system, plus abap-smartfix.bufferedTables (upper case, sorted) */
function bufferedTables(uri) {
  const own = cfg(uri).get('bufferedTables', []) || [];
  const facts = extContext && extContext.globalState ? extContext.globalState.get(FACTS_KEY, {}) : {};
  const learned = Object.keys(((facts[factsDestination(uri)] || {}).buffered) || {});
  return [...new Set(own.concat(learned).map((t) => String(t).toUpperCase()))].sort();
}

/** Remember the buffered tables an ATC run reported, so the source rules know them without ATC */
async function rememberFacts(doc, findings) {
  const dest = factsDestination(doc.uri);
  if (!extContext || !extContext.globalState || !dest) return;
  const found = Atc.factsFrom(findings).buffered;
  const facts = extContext.globalState.get(FACTS_KEY, {});
  const mine = Object.assign({ buffered: {} }, facts[dest]);
  const added = Object.keys(found).filter((t) => mine.buffered[t] !== found[t]);
  if (!added.length) return;
  mine.buffered = Object.assign({}, mine.buffered, found);
  await extContext.globalState.update(FACTS_KEY, Object.assign({}, facts, { [dest]: mine }));
  log('ATC: remembered buffered tables of ' + dest + ': ' + added.map((t) => t + ' (' + found[t] + ')').join(', '));
}

/** ADT destination whose DDIC is used for this document, or '' (DDIC lookups off or no destination) */
function ddicDestination(uri) {
  const conf = cfg(uri);
  if (!conf.get('ddic.enabled', true)) return '';
  return DdicAdt.destinationOf(uri, conf.get('ddic.destination', ''));
}

// ---------------------------------------------------------------- ATC from the SAP system

/** Per document: the match of the last ATC run { version, confirmed, unconfirmed, unmatched } (atc.js) */
const atcState = new Map();
const ATC_TIMEOUT_MS = 180000;
const SAVE_AND_RUN = 'Save and Run ATC';
/** Per document: the version whose "save and run ATC" was declined, so it is not asked again for it */
const saveDeclined = new Map();
/** Picking a check variant in ADT's quick pick (runAtcWithVariant): time for it to open, for the paste, accept retries */
const VARIANT_OPEN_MS = 800;
const VARIANT_PASTE_MS = 300;
const VARIANT_ACCEPT_TRIES = 3;
const VARIANT_RETRY_MS = 1000;

/** abap-smartfix.atc.enabled: whether ATC results from ADT are used (uri: the document's scope, or the global setting) */
function atcSwitchedOn(uri) {
  return cfg(uri).get('atc.enabled', true);
}

/** abap-smartfix.atc.checkVariant: { name, error }, name '' for the system's default check variant (atc.js) */
function atcVariant(uri) {
  return Atc.checkVariantOf(cfg(uri).get('atc.checkVariant', 'DEFAULT'));
}

/** abap-smartfix.atc.checkVariantDelay: ms the variant search in ADT's quick pick is given before the first match is taken */
function atcVariantDelay(uri) {
  const ms = Number(cfg(uri).get('atc.checkVariantDelay', 2000));
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 500), 30000) : 2000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function atcEnabled(doc) {
  return !atcOffReason(doc);
}

/** Why ATC results cannot be used for this document, or '' when they can */
function atcOffReason(doc) {
  if (!atcSwitchedOn(doc.uri)) return 'ATC results from ADT are switched off';
  if (doc.uri.scheme !== 'abap') return doc.fileName + ' is not opened from ABAP Development Tools (scheme ' + doc.uri.scheme + ')';
  if (!vscode.extensions.getExtension('sapse.adt-vscode')) return 'ABAP Development Tools for VS Code is not installed';
  return '';
}

/**
 * Before a fix from the sidebar, a selection or the whole workspace: run ATC first when it is switched on, so the fix
 * uses what ATC reports (as Analyze / Auto Fix do). With ATC off the last ATC result of an Analyze stays in use.
 */
async function ensureAtc(doc) {
  if (atcSwitchedOn(doc.uri)) await runAtc(doc);
}

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
  const result = analyzeText(doc, opts);
  const state = atcState.get(doc.uri.toString());
  // The ATC result of the last explicit Analyze stays in use until the next one (also after switching ATC off)
  if (state) Atc.applyAtc(result, state, state.version === doc.version, opts);
  return result;
}

/**
 * Run ATC on the document in the SAP system through ABAP Development Tools for VS Code (the same as its "Run ATC" command,
 * with the system's default check variant or the one of abap-smartfix.atc.checkVariant) and remember which findings ATC
 * confirms. Only for saved objects opened from ADT; when ATC cannot be run, fails, times out or reports nothing, the
 * findings are decided from the source as before.
 * @returns {Promise<boolean>} whether an ATC result is in use for this version
 */
async function runAtc(doc) {
  const key = doc.uri.toString();
  const off = atcOffReason(doc);
  if (off) {
    // Analyze with ATC switched off: back to the findings of the source
    if (atcSwitchedOn(doc.uri)) log('ATC not run: ' + off + '; findings are decided from the source.');
    atcState.delete(key);
    return false;
  }
  const known = atcState.get(key);
  const variant = atcVariant(doc.uri);
  if (variant.error) {
    log('ATC not run: ' + variant.error + '; findings are decided from the source.');
    vscode.window.showWarningMessage('SmartFix for ABAP: ' + variant.error + '. ATC was not run; fix the setting or set it to DEFAULT.');
    return !!known;
  }
  // A result of another check variant does not count: the variant decides which checks run
  const current = () => known && known.version === doc.version && known.variant === variant.name;
  if (current()) {
    log('ATC: using the result of the last ATC run for ' + doc.fileName + ' (unchanged since).');
    return true;
  }
  if (doc.isDirty) {
    // ATC checks the version in the system: after a fix, save it first so ATC checks the fixed code (nothing is discarded).
    // Asked once per version: one command calls this more than once
    if (saveDeclined.get(key) === doc.version) return !!known;
    const pick = await vscode.window.showInformationMessage(
      'SmartFix for ABAP: ' + path.basename(doc.fileName) + ' has unsaved changes. ATC checks the version in the SAP system; ' +
        'save the file and run ATC on it?',
      SAVE_AND_RUN, 'Not Now'
    );
    if (pick !== SAVE_AND_RUN || !(await doc.save()) || doc.isDirty) {
      saveDeclined.set(key, doc.version);
      log('ATC not run: ' + doc.fileName + ' has unsaved changes; the last ATC result stays in use.');
      return !!known;
    }
    if (current()) return true;
  }
  const version = doc.version;
  // ADT runs ATC on the active editor, so the file comes to the front; an open diff preview is brought back afterwards
  const diff = findPreviewTab(key);
  const diffWasActive = !!(diff && diff.isActive);
  try {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.toString() !== key) await vscode.window.showTextDocument(doc, { preview: false });
    if (variant.name) log('ATC: running with check variant ' + variant.name + ' on ' + doc.fileName + '.');
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SmartFix for ABAP: running ATC' + (variant.name ? ' (check variant ' + variant.name + ')' : '') + ' in the SAP system…',
      },
      () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout after ' + ATC_TIMEOUT_MS / 1000 + ' s')), ATC_TIMEOUT_MS);
        const run = variant.name
          ? runAtcWithVariant(doc, variant.name, atcVariantDelay(doc.uri))
          : vscode.commands.executeCommand('adt-vscode.runAtcOnObject');
        Promise.resolve(run).then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); });
      })
    );
  } catch (e) {
    log('ATC could not be run (' + (e && e.message ? e.message : e) + '); findings are decided from the source.');
    return !!known;
  } finally {
    if (diffWasActive) await showPreviewDiff(key);
  }
  if (doc.version !== version) return !!known;
  const findings = Atc.readAtcDiagnostics(vscode.languages.getDiagnostics(doc.uri));
  await rememberFacts(doc, findings);
  // No findings: ATC found nothing in this version. That is a result too: findings of the checks ATC runs are hidden,
  // and this version is not checked again by the next command
  if (!findings.length) log('ATC reported no findings for ' + doc.fileName + '.');
  const result = analyzeText(doc, readOptions(doc.uri));
  const m = Atc.matchAtc(result, findings);
  atcState.set(key, Object.assign({ version, variant: variant.name }, m));
  log('ATC: ' + findings.length + ' findings in ' + doc.fileName + ': ' + m.confirmed.size + ' matched, ' +
    m.unconfirmed.size + ' SmartFix for ABAP findings not reported by ATC hidden, ' + m.unmatched.length + ' without a rule (manual).');
  for (const u of m.unmatched) {
    const cls = u.atc.checkClass || '(' + Atc.classesLabel(u.atc.classes || []) + ')';
    log('  ATC without a rule: line ' + (u.atc.line + 1) + ' ' + cls + ' ' + u.atc.messageId + ' "' + u.atc.message + '"');
  }
  return true;
}

/**
 * Run ATC with a check variant. ADT's "Run ABAP Test Cockpit With..." takes no arguments: it asks for the variant in a quick
 * pick that searches the system as you type. VS Code has no command that types into a quick pick, so the name is pasted
 * through the clipboard (its text is put back afterwards) and the first match is accepted once the search had delayMs to
 * answer, a few more times while nothing matched yet. When that does not work the quick pick stays open with the name
 * filled in, to pick by hand.
 * @returns {Promise} settles when ADT's command has finished
 */
function runAtcWithVariant(doc, name, delayMs) {
  let done = false;
  const run = Promise.resolve(vscode.commands.executeCommand('adt-vscode.runAtcOnObjectWithVariant'));
  run.then(() => { done = true; }, () => { done = true; });
  pickAtcVariant(doc, name, delayMs, () => done).catch((e) =>
    log('ATC: check variant ' + name + ' could not be picked (' + (e && e.message ? e.message : e) + '); pick it in the open list.'));
  return run;
}

async function pickAtcVariant(doc, name, delayMs, done) {
  await sleep(VARIANT_OPEN_MS);
  if (done()) return;
  const version = doc.version;
  const saved = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText(name);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    // The paste reads the clipboard after the command returns
    await sleep(VARIANT_PASTE_MS);
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
  if (doc.version !== version) {
    // The quick pick had not taken the focus: the name went into the code. Take it out again and leave the pick to the user
    await vscode.commands.executeCommand('undo');
    throw new Error('the quick pick of ADT did not open in time');
  }
  await sleep(delayMs);
  for (let i = 0; i < VARIANT_ACCEPT_TRIES && !done(); i++) {
    if (i) await sleep(VARIANT_RETRY_MS);
    // Accepts ADT's quick pick while it is open; once it is closed this does nothing
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  }
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
  refreshPreviews(doc);

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
  const atcOn = atcSwitchedOn();
  const variant = atcVariant().name;
  statusBar.text = '$(wand) SmartFix for ABAP ' + total + (atcOn ? ' · ATC $(check)' + (variant ? ' ' + variant : '') : '');
  statusBar.tooltip = total + ' finding' + (total === 1 ? '' : 's') + ' (code rewrites or Pragma / Pseudo Comment). ' +
    (atcOn ? 'ATC results from ADT: on (check variant ' + (variant || 'DEFAULT') + '). ' : 'ATC results from ADT: off (decided from the source). ') +
    'Click to show the list.';
  statusBar.show();
}

/** Show whether ATC results from ADT are used: sidebar title and status bar */
function showAtcState() {
  const on = atcSwitchedOn();
  const variant = atcVariant().name;
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
  atcState.delete(key);
  saveDeclined.delete(key);
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
  // Follow the lines ATC checked, so each ATC finding stays with its statement after a fix, an undo or typing
  const state = atcState.get(key);
  if (state) {
    Atc.trackChanges(state, e.contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, text: c.text })));
  }
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
    previewContent.delete(key);
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
  if (applied && atcEnabled(doc)) {
    log('ATC: ' + applied + ' fixes applied to ' + doc.fileName + '. Save (it goes to the SAP system), then ATC checks the fixed code.');
    vscode.window.showInformationMessage('SmartFix for ABAP: save the fixed file and re-check it with ATC?', SAVE_AND_RUN).then(async (pick) => {
      if (pick !== SAVE_AND_RUN || doc.isClosed) return;
      if (doc.isDirty && !(await doc.save())) return;
      await runAtc(doc);
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
      await ensureAtc(doc);
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
  await ensureAtc(doc);
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

// ---------------------------------------------------------------- diff preview

const PREVIEW_SCHEME = 'abap-smartfix-preview';
/** @type {Map<string, {uri: vscode.Uri, source: string, mode: string|null, text: string}>} preview uri -> content */
const previewContent = new Map();

class PreviewContentProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  provideTextDocumentContent(uri) {
    const p = previewContent.get(uri.toString());
    return p ? p.text : '';
  }
}

let previewProvider;

function fixedText(doc, mode) {
  return applyEditsToText(doc.getText(), planFor(doc, { all: true, mode }).plan.edits);
}

/** Recompute open previews of the document, e.g. after fixes were applied or the file was saved */
function refreshPreviews(doc) {
  if (!previewProvider) return;
  const key = doc.uri.toString();
  for (const p of previewContent.values()) {
    if (p.source !== key) continue;
    p.text = fixedText(doc, p.mode);
    previewProvider._onDidChange.fire(p.uri);
  }
}

/** Open a diff of the current content against the auto-fixed content, without touching the file */
async function previewFix(doc, mode) {
  scanDocument(doc);
  return openPreview(doc, mode, false);
}

/**
 * The diff preview: the original on the left, the fixed code on the right, in one editor. quiet: opened from the sidebar,
 * without messages when there is nothing to preview. Returns the fixed text, or null when nothing was opened.
 */
async function openPreview(doc, mode, quiet) {
  const { picked, plan } = planFor(doc, { all: true, mode });
  if (!picked.length) {
    if (!quiet) vscode.window.showInformationMessage('Nothing to fix.');
    return null;
  }
  // A diff without changes shows no red / green at all: say why instead of opening it
  if (!plan.edits.length) {
    if (quiet) return null;
    const manual = tally(plan).manual;
    logUnfixable(doc, plan);
    vscode.window.showInformationMessage('No automatic changes to preview: ' + manual + ' finding' + (manual === 1 ? '' : 's') +
      ' need manual fixing (see the Output panel).');
    if (output) output.show(true);
    return null;
  }
  const fixed = applyEditsToText(doc.getText(), plan.edits);
  const name = path.basename(doc.fileName);
  const puri = vscode.Uri.parse(
    PREVIEW_SCHEME + ':/' + encodeURIComponent(name) + '?' + encodeURIComponent(doc.uri.toString())
  );
  previewContent.set(puri.toString(), { uri: puri, source: doc.uri.toString(), mode: mode || null, text: fixed });
  previewProvider._onDidChange.fire(puri);
  await ensureSideBySide();
  // In the editor group that shows the file, not beside it; pinned (preview: false), so opening a finding does not replace it
  const key = doc.uri.toString();
  const shown = (vscode.window.visibleTextEditors || []).find((e) => e.document.uri.toString() === key);
  const options = { preview: false };
  if (shown && shown.viewColumn) options.viewColumn = shown.viewColumn;
  await vscode.commands.executeCommand('vscode.diff', doc.uri, puri, name + ' ↔ Auto Fix Preview', options);
  return fixed;
}

/**
 * Side by side: the original on the left, the preview on the right. VS Code shows a diff inline when it is off or when the
 * editor is narrow; abap-smartfix.preview.sideBySide (default on) turns both off in the user settings, once.
 */
async function ensureSideBySide() {
  if (!cfg().get('preview.sideBySide', true)) return;
  const de = vscode.workspace.getConfiguration('diffEditor');
  try {
    if (de.get('renderSideBySide') === false) await de.update('renderSideBySide', true, vscode.ConfigurationTarget.Global);
    if (de.get('useInlineViewWhenSpaceIsLimited') !== false) {
      await de.update('useInlineViewWhenSpaceIsLimited', false, vscode.ConfigurationTarget.Global);
      log('Preview: diffEditor.useInlineViewWhenSpaceIsLimited set to false, so the preview stays side by side ' +
        '(turn off abap-smartfix.preview.sideBySide to keep your own diff settings).');
    }
  } catch (e) {
    log('Preview: could not set the diff editor to side by side: ' + (e && e.message ? e.message : e));
  }
}

/** The editor of the file inside its diff preview (the left side), waiting briefly for VS Code to show it */
async function originalSideOf(key, tab) {
  for (let i = 0; i < 20; i++) {
    const ed = (vscode.window.visibleTextEditors || []).find((e) =>
      e.document.uri.toString() === key && (!tab || e.viewColumn === tab.group.viewColumn));
    if (ed) return ed;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** The still open diff preview tab of a file, if any */
function findPreviewTab(sourceKey) {
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const input = t.input;
      if (!input || !input.original || !input.modified) continue;
      const p = previewContent.get(input.modified.toString());
      if (p && p.source === sourceKey && input.original.toString() === sourceKey) return t;
    }
  }
  return null;
}

/**
 * Bring an open diff preview of the file back to the front (e.g. after switching to the plain file tab),
 * so both the original and the preview are shown. Returns the diff tab, or null when there is none.
 */
async function showPreviewDiff(sourceKey) {
  const tab = findPreviewTab(sourceKey);
  if (!tab) return null;
  if (!tab.isActive) {
    const input = tab.input;
    await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, {
      preview: false,
      viewColumn: tab.group.viewColumn,
    });
  }
  return tab;
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
  await ensureAtc(doc);
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
  for (const doc of vscode.workspace.textDocuments || []) if (keys.has(doc.uri.toString())) refreshPreviews(doc);
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
  extContext = context;
  output = vscode.window.createOutputChannel('SmartFix for ABAP');
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
  previewProvider = new PreviewContentProvider();

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
    const preview = previewContent.get(ed.document.uri.toString());
    if (preview) {
      const source = vscode.workspace.textDocuments.find((d) => d.uri.toString() === preview.source);
      return source || vscode.workspace.openTextDocument(vscode.Uri.parse(preview.source));
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

    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),

    vscode.languages.registerCodeActionsProvider(selector, new SmartFixCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Source, FIX_ALL_KIND],
    }),

    vscode.commands.registerCommand('abap-smartfix.scanFile', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await runAtc(doc);
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
      await runAtc(doc);
      await showSidebar();
      await confirmAndApply(doc, null);
    }),

    vscode.commands.registerCommand('abap-smartfix.applySuppressOnly', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await runAtc(doc);
      await showSidebar();
      await confirmAndApply(doc, 'suppress');
    }),

    vscode.commands.registerCommand('abap-smartfix.previewFix', async () => {
      const doc = await activeAbapDoc();
      if (!doc) return;
      await runAtc(doc);
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
      let diffTab = await showPreviewDiff(key);
      if (!diffTab && cfg(uri).get('preview.onReveal', true) && store.has(key)) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (await openPreview(doc, null, true)) diffTab = findPreviewTab(key);
        } catch (e) {
          log('Preview could not be opened: ' + (e && e.message ? e.message : e));
        }
      }
      let editor = diffTab ? await originalSideOf(key, diffTab) : null;
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
      if (atcSwitchedOn(doc.uri) && !atcState.has(entry.uri.toString())) {
        await runAtc(doc);
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

    vscode.commands.registerCommand('abap-smartfix.toggleAtc', () => setAtc(!atcSwitchedOn())),
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
