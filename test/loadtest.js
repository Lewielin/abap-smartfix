'use strict';

/**
 * Load extension.js with a fake vscode module and verify that:
 *   - there are no syntax errors and activate() completes
 *   - the commands are registered
 *   - analyzing produces diagnostics and tree nodes
 *   - "Auto fix whole file" produces the right insert / replace edits
 *   - diff preview, suppress-only mode, and Quick Fix offer both rewrite and annotation
 *
 * Run:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test\loadtest.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

let failed = 0;
// Replace edits other than those that tidy end-of-line comments ("#EC …)
const codeReplaces = (edit) => edit.replaces.filter((r) => !/^"/.test(r.text));

function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

// ------------------------------------------------------------------ vscode stub

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class Selection extends Range {}
class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { this.listeners.forEach((f) => f(v)); }
  dispose() {}
}
class TreeItem {
  constructor(label, state) { this.label = label; this.collapsibleState = state; }
}
class ThemeIcon {
  constructor(id) { this.id = id; }
}
ThemeIcon.File = new ThemeIcon('file');
class MarkdownString {
  constructor(v) { this.value = v || ''; }
  appendText(t) { this.value += t; return this; }
  appendMarkdown(t) { this.value += t; return this; }
}
class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}
class CodeActionKindStub {
  constructor(value) { this.value = value; }
  append(part) { return new CodeActionKindStub(this.value + '.' + part); }
  contains(other) { return other.value === this.value || other.value.indexOf(this.value + '.') === 0; }
  intersects(other) { return this.contains(other) || other.contains(this); }
}
class CodeAction {
  constructor(title, kind) { this.title = title; this.kind = kind; }
}
class WorkspaceEdit {
  constructor() { this.inserts = []; this.replaces = []; }
  insert(uri, position, text) { this.inserts.push({ uri, position, text }); }
  replace(uri, range, text) { this.replaces.push({ uri, range, text }); }
}

const Uri = {
  file: (p) => ({
    scheme: 'file',
    fsPath: p,
    path: '/' + p.replace(/\\/g, '/'),
    toString() { return 'file:///' + p.replace(/\\/g, '/'); },
  }),
  parse: (s) => ({ scheme: s.split(':')[0], toString() { return s; } }),
};

function makeDoc(file, text, version) {
  if (text == null) text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r\n|\n|\r/);
  return {
    uri: Uri.file(file),
    version: version || 1,
    fileName: file,
    languageId: 'abap',
    isUntitled: false,
    lineCount: lines.length,
    eol: 1,
    getText: () => text,
    lineAt: (n) => ({
      text: lines[n] || '',
      range: new Range(n, 0, n, (lines[n] || '').length),
      firstNonWhitespaceCharacterIndex: (lines[n] || '').search(/\S|$/),
    }),
    _lines: lines,
  };
}

const settings = {
  fileExtensions: ['.abap'],
  include: '**/*.abap',
  exclude: '**/node_modules/**',
  maxFiles: 500,
  scanOnSave: true,
  scanOnOpen: false,
  diagnosticSeverity: 'information',
  // This test covers the SELECT SINGLE rewrite flow, so list every SELECT SINGLE
  selectSingleCheck: 'all',
  // The counts below are those of samples/demo.abap before CLIENT SPECIFIED → USING CLIENT existed (tested in run.js / atc.js)
  disabledRules: ['client-specified-obsolete'],
  enabledRules: [],
  tokenOverrides: {},
  subrcLookahead: 3,
  customRulesFile: '.abap-smartfix-rules.json',
  promptIncludeSource: true,
};

const registered = new Map();
const diagStore = new Map();
const messages = [];
let appliedEdit = null;
let activeDoc = null;
const executed = [];
let contentProvider = null;
let visibleEditors = [];
let hideActiveEditor = false;
const configUpdates = [];
let shownDocs = 0;
let tabListener = null;
let changeListener = null;
let checkboxListener = null;
let quickPickAnswer = (items) => undefined;
let adtInstalled = false;
const adtDiagnostics = new Map();
let atcResult = [];
let atcRuns = 0;

const vscodeStub = {
  Position, Range, Selection, EventEmitter, TreeItem, ThemeIcon, MarkdownString,
  Diagnostic, CodeAction, WorkspaceEdit, Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  TextEditorRevealType: { InCenter: 2 },
  CodeActionKind: {
    QuickFix: new CodeActionKindStub('quickfix'),
    Source: new CodeActionKindStub('source'),
    SourceFixAll: new CodeActionKindStub('source.fixAll'),
  },
  EndOfLine: { LF: 1, CRLF: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    get activeTextEditor() { return activeDoc && !hideActiveEditor ? { document: activeDoc, selection: null, revealRange() {} } : null; },
    get visibleTextEditors() { return visibleEditors; },
    tabGroups: {
      all: [{ tabs: [] }],
      onDidChangeTabs: (fn) => { tabListener = fn; return { dispose() {} }; },
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    createTreeView: (id, opts) => ({
      id, opts, provider: opts.treeDataProvider, dispose() {},
      onDidChangeCheckboxState: (fn) => { checkboxListener = fn; return { dispose() {} }; },
    }),
    showInformationMessage: (m) => { messages.push(['info', m]); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { messages.push(['warn', m]); return Promise.resolve('Apply'); },
    showErrorMessage: (m) => { messages.push(['error', m]); return Promise.resolve(undefined); },
    showTextDocument: (doc) => { shownDocs++; return Promise.resolve({ document: doc, selection: null, revealRange() {} }); },
    showQuickPick: (items, opts) => Promise.resolve(quickPickAnswer(items, opts)),
    withProgress: (o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
  },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, d) => diagStore.set(uri.toString(), d),
      delete: (uri) => diagStore.delete(uri.toString()),
      clear: () => diagStore.clear(),
      dispose() {},
    }),
    registerCodeActionsProvider: (sel, prov) => { vscodeStub._codeActionProvider = prov; return { dispose() {} }; },
    getDiagnostics: (uri) => adtDiagnostics.get(uri.toString()) || [],
  },
  // ABAP Development Tools for VS Code: installed only for the ATC test
  extensions: { getExtension: (id) => (adtInstalled && id === 'sapse.adt-vscode' ? { id } : undefined) },
  commands: {
    registerCommand: (id, fn) => { registered.set(id, fn); return { dispose() {} }; },
    executeCommand: (...args) => {
      executed.push(args);
      // ADT's "Run ATC" publishes the ATC result as diagnostics of the active document
      if (args[0] === 'adt-vscode.runAtcOnObject' && activeDoc) {
        atcRuns++;
        adtDiagnostics.set(activeDoc.uri.toString(), atcResult);
      }
      return Promise.resolve();
    },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(path.join(__dirname, '..')), name: 'root', index: 0 }],
    getWorkspaceFolder: () => vscodeStub.workspace.workspaceFolders[0],
    getConfiguration: (section) => ({ get: (k, d) => (k in settings ? settings[k] : d), update: (k, v) => { configUpdates.push([section, k, v]); return Promise.resolve(); } }),
    asRelativePath: (u) => path.basename(u.fsPath),
    openTextDocument: (uri) => Promise.resolve(activeDoc),
    applyEdit: (edit) => { appliedEdit = edit; return Promise.resolve(true); },
    registerTextDocumentContentProvider: (scheme, prov) => { contentProvider = { scheme, prov }; return { dispose() {} }; },
    findFiles: () => Promise.resolve([]),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: (fn) => { changeListener = fn; return { dispose() {} }; },
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

// ------------------------------------------------------------------ tests

const ext = require('../src/extension');
const subs = [];
const globalStore = new Map();
const globalState = { get: (k, d) => (globalStore.has(k) ? globalStore.get(k) : d), update: (k, v) => { globalStore.set(k, v); return Promise.resolve(); } };
ext.activate({ subscriptions: subs, globalState });

console.log('\n== Activation ==');
check('activate does not throw', true);
check('subscriptions registered', subs.length > 10, String(subs.length));
[
  'abap-smartfix.scanFile',
  'abap-smartfix.scanWorkspace',
  'abap-smartfix.applyAll',
  'abap-smartfix.applyFindings',
  'abap-smartfix.applySuppressOnly',
  'abap-smartfix.previewFix',
  'abap-smartfix.applyWorkspace',
  'abap-smartfix.applyFile',
  'abap-smartfix.copyAiPrompt',
  'abap-smartfix.showAiPrompt',
  'abap-smartfix.showReport',
  'abap-smartfix.listRules',
  'abap-smartfix.clear',
  'abap-smartfix.fixFinding',
  'abap-smartfix.fixSelection',
  'abap-smartfix.checkAll',
  'abap-smartfix.uncheckAll',
].forEach((id) => check('command registered ' + id, registered.has(id)));

activeDoc = makeDoc(path.join(__dirname, '..', 'samples', 'demo.abap'));

(async () => {
  console.log('\n== Analyze ==');
  await registered.get('abap-smartfix.scanFile')();
  const diags = diagStore.get(activeDoc.uri.toString()) || [];
  // 16 findings + 1 ##NO_TEXT (on by default) + 2 ineffective #EC after the first on the same line (legacy form)
  check('diagnostics created', diags.length === 20, String(diags.length));
  check('analyzing shows the sidebar', executed.some((a) => a[0] === 'abap-smartfix.findings.focus'));
  check('auto-fixable diagnostics are marked', diags.some((d) => /^\[Auto-fixable\] /.test(d.message)));
  check('diagnostic message contains the token', /Missing "#EC |Missing ##/.test(diags[0].message), diags[0] && diags[0].message);
  check('diagnostic ranges are inside the file', diags.every((d) => d.range.start.line < activeDoc.lineCount));

  console.log('\n== Tree view ==');
  const view = subs.find((s) => s && s.provider);
  const fileNodes = view.provider.getChildren();
  check('tree has 1 file node', fileNodes.length === 1, String(fileNodes.length));
  const children = view.provider.getChildren(fileNodes[0]);
  check('file node has 20 children', children.length === 20, String(children.length));
  check('rewrite item label shows the rewrite', children.some((c) => /^L35\s+Rewrite: SELECT SINGLE/.test(String(c.label))));
  check('node label has line number and token', /^L\d+\s+("#EC |##)/.test(String(children[0].label)), String(children[0].label));

  console.log('\n== Checkboxes ==');
  check('file and findings start checked', fileNodes[0].checkboxState.state === 1 && children.every((c) => c.checkboxState.state === 1));
  const ss35 = children.find((c) => /^L35\s+Rewrite: SELECT SINGLE/.test(String(c.label)));
  check('(precondition) checkbox listener registered', typeof checkboxListener === 'function');
  checkboxListener({ items: [[ss35, 0]] });
  const afterUncheck = view.provider.getChildren();
  check('file node shows the checked count', /20 findings · 19 checked/.test(afterUncheck[0].description), afterUncheck[0].description);
  check('file checkbox is cleared when a finding is unchecked', afterUncheck[0].checkboxState.state === 0);
  check('the unchecked finding stays unchecked after a rescan',
    (await registered.get('abap-smartfix.scanFile')(), view.provider.getChildren(view.provider.getChildren()[0]))
      .find((c) => /^L35\s+Rewrite/.test(String(c.label))).checkboxState.state === 0);
  appliedEdit = null;
  await registered.get('abap-smartfix.applyFindings')(activeDoc.uri, { all: true });
  check('auto fix skips the unchecked SELECT SINGLE (1 of 2 rewritten)', !!appliedEdit && codeReplaces(appliedEdit).length === 1,
    appliedEdit ? String(codeReplaces(appliedEdit).length) : 'null');
  appliedEdit = null;
  const warnCount = messages.length;
  await registered.get('abap-smartfix.applyAll')();
  check('confirmation mentions the skipped finding', messages.slice(warnCount).some((m) => /1 unchecked in the sidebar is skipped/.test(m[1])),
    JSON.stringify(messages.slice(warnCount)));
  appliedEdit = null;
  await registered.get('abap-smartfix.fixFinding')(ss35);
  check('fixing one finding from the sidebar ignores its checkbox and touches only it',
    !!appliedEdit && codeReplaces(appliedEdit).length === 1 && appliedEdit.inserts.every((i) => i.position.line >= 33 && i.position.line <= 38),
    appliedEdit ? JSON.stringify(appliedEdit.inserts.map((i) => i.position.line)) : 'null');
  appliedEdit = null;
  await registered.get('abap-smartfix.uncheckAll')();
  await registered.get('abap-smartfix.applyFindings')(activeDoc.uri, { all: true });
  check('with everything unchecked nothing is fixed', appliedEdit === null);
  await registered.get('abap-smartfix.checkAll')();
  check('check all restores every checkbox', view.provider.getChildren(view.provider.getChildren()[0]).every((c) => c.checkboxState.state === 1));
  checkboxListener({ items: [[view.provider.getChildren()[0], 0]] });
  check('unchecking the file unchecks all its findings',
    view.provider.getChildren(view.provider.getChildren()[0]).every((c) => c.checkboxState.state === 0));
  await registered.get('abap-smartfix.checkAll')();
  check('tree view manages checkbox state manually', view.opts.manageCheckboxStateManually === true);
  const firstKid = view.provider.getChildren(view.provider.getChildren()[0])[0];
  checkboxListener({ items: [[firstKid, 0], [view.provider.getChildren()[0], 0]] });
  check('a finding unchecked together with its file node unchecks only that finding',
    view.provider.getChildren(view.provider.getChildren()[0]).filter((c) => c.checkboxState.state === 0).length === 1);
  await registered.get('abap-smartfix.checkAll')();

  console.log('\n== Fix findings in selection ==');
  const selActions = vscodeStub._codeActionProvider.provideCodeActions(activeDoc, new Range(27, 0, 36, 0));
  const selAction = selActions.find((a) => /^Fix findings in selection… \(\d+\)$/.test(a.title));
  check('multi-line selection offers "Fix findings in selection…"', !!selAction, selActions.map((a) => a.title).join(' | '));
  let offered = null;
  quickPickAnswer = (items, opts) => { offered = { items, opts }; return items.filter((it) => /SELECT SINGLE/.test(it.label)); };
  appliedEdit = null;
  await registered.get('abap-smartfix.fixSelection')(...selAction.command.arguments);
  check('picker lists only findings in the selected lines, all checked, multi-select',
    !!offered && offered.opts.canPickMany && offered.items.length > 1 && offered.items.every((it) => it.picked) &&
      offered.items.every((it) => { const l = +/^L(\d+)/.exec(it.label)[1]; return l >= 28 && l <= 36; }),
    offered ? offered.items.map((it) => it.label).join(' | ') : 'no picker');
  check('only the picked finding is fixed', !!appliedEdit && codeReplaces(appliedEdit).length === 1 &&
    /UP TO 1 ROWS/.test(appliedEdit.inserts.map((i) => i.text).join('|')) &&
    // Only the "#EC CI_NOORDER the rewrite to UP TO 1 ROWS brings along
    !/"#EC (?!CI_NOORDER)/.test(appliedEdit.inserts.map((i) => i.text).join('|')));
  quickPickAnswer = () => undefined;
  appliedEdit = null;
  await registered.get('abap-smartfix.fixSelection')(activeDoc.uri, 27, 36);
  check('cancelling the picker changes nothing', appliedEdit === null);
  // The editor context menu passes only the file uri (plus a context object), no lines
  let ctxOffered = null;
  quickPickAnswer = (items) => { ctxOffered = items; return undefined; };
  hideActiveEditor = true;
  visibleEditors = [{ document: activeDoc, selection: { start: { line: 27, character: 0 }, end: { line: 36, character: 0 } } }];
  await registered.get('abap-smartfix.fixSelection')(activeDoc.uri, { groupId: 0 });
  check('context menu (uri only) uses the selection of that file',
    !!ctxOffered && ctxOffered.length > 1 && ctxOffered.every((it) => { const l = +/^L(\d+)/.exec(it.label)[1]; return l >= 28 && l <= 36; }),
    ctxOffered ? ctxOffered.map((it) => it.label).join(' | ') : 'no picker');
  visibleEditors = [];
  hideActiveEditor = false;
  quickPickAnswer = (items) => undefined;

  console.log('\n== Quick Fix ==');

  const actions = vscodeStub._codeActionProvider.provideCodeActions(activeDoc, new Range(27, 0, 27, 1));
  check('line 28 offers quick fixes', actions.length >= 5, String(actions.length));
  check('"Auto fix whole file" action exists', actions.some((a) => /Auto fix whole file/.test(a.title)));
  const ssActions = vscodeStub._codeActionProvider.provideCodeActions(activeDoc, new Range(67, 0, 67, 1));
  const ssTitles = ssActions.map((a) => a.title);
  check('SELECT SINGLE offers a rewrite', ssTitles.some((t) => /^Rewrite: SELECT SINGLE/.test(t)), ssTitles.join(' | '));
  check('SELECT SINGLE also offers "#EC CI_NOORDER', ssTitles.some((t) => /Add "#EC CI_NOORDER/.test(t)), ssTitles.join(' | '));
  check('rewrite is listed before the annotation',
    ssTitles.findIndex((t) => /^Rewrite: /.test(t)) < ssTitles.findIndex((t) => /^Add "#EC CI_NOORDER/.test(t)));

  console.log('\n== Auto fix on save (source.fixAll) ==');
  const fixAll = vscodeStub._codeActionProvider.provideCodeActions(
    activeDoc, new Range(0, 0, 0, 0), { only: vscodeStub.CodeActionKind.SourceFixAll }
  );
  check('source.fixAll returns 1 action', fixAll.length === 1, String(fixAll.length));
  check('action kind is source.fixAll.abap-smartfix', fixAll[0] && fixAll[0].kind.value === 'source.fixAll.abap-smartfix');
  check('action carries the edit directly (no dialog on save)', fixAll[0] && !!fixAll[0].edit && !fixAll[0].command &&
    fixAll[0].edit.inserts.length > 0 && codeReplaces(fixAll[0].edit).length === 2);
  check('regular Quick Fix requests do not include fixAll',
    !vscodeStub._codeActionProvider.provideCodeActions(activeDoc, new Range(27, 0, 27, 1), { only: undefined })
      .some((a) => a.kind && a.kind.value === 'source.fixAll.abap-smartfix'));
  check('fixAll does not modify the file (only returns edits)', appliedEdit === null);

  console.log('\n== Diff preview ==');
  await registered.get('abap-smartfix.previewFix')();
  const diffCall = executed.find((a) => a[0] === 'vscode.diff');
  check('vscode.diff opened', !!diffCall);
  check('preview content provider registered', !!contentProvider && contentProvider.scheme === 'abap-smartfix-preview');
  const previewText = diffCall ? contentProvider.prov.provideTextDocumentContent(diffCall[2]) : '';
  check('preview contains UP TO 1 ROWS and ENDSELECT', /UP TO 1 ROWS/.test(previewText) && /ENDSELECT\./.test(previewText));
  check('preview does not modify the file', appliedEdit === null);
  check('diff opens as a pinned tab (preview: false)', !!diffCall && !!diffCall[4] && diffCall[4].preview === false);
  check('the preview is kept side by side, also in a narrow window (diffEditor.useInlineViewWhenSpaceIsLimited = false)',
    configUpdates.some((u) => u[0] === 'diffEditor' && u[1] === 'useInlineViewWhenSpaceIsLimited' && u[2] === false), JSON.stringify(configUpdates));

  // Diff has focus (right side is the preview document); the file is visible as the diff's left side
  hideActiveEditor = true;
  let revealed = null;
  visibleEditors = [{ document: activeDoc, selection: null, revealRange(r) { revealed = r; } }];
  shownDocs = 0;
  await registered.get('abap-smartfix.reveal')(activeDoc.uri, 9, 2);
  check('sidebar click reuses the diff left side (does not open the file over the diff)', shownDocs === 0);
  check('sidebar click moves the cursor in the diff', !!revealed && visibleEditors[0].selection.start.line === 9);
  visibleEditors = [];
  await registered.get('abap-smartfix.reveal')(activeDoc.uri, 9, 2);
  check('file not visible: sidebar click opens it', shownDocs === 1);
  hideActiveEditor = false;

  console.log('\n== Suppress only ==');
  await registered.get('abap-smartfix.applySuppressOnly')();
  check('suppress-only mode replaces no code (only tidies comments)', !!appliedEdit && codeReplaces(appliedEdit).length === 0);
  const suppressText = appliedEdit ? appliedEdit.inserts.map((i) => i.text).join('|') : '';
  check('suppress-only mode adds no ENDSELECT', !/ENDSELECT/.test(suppressText), suppressText);
  check('suppress-only mode uses "#EC CI_NOORDER for SELECT SINGLE', /#EC CI_NOORDER/.test(suppressText));
  appliedEdit = null;

  console.log('\n== Sidebar file button / whole workspace ==');
  const warnBefore = messages.filter((m) => m[0] === 'warn').length;
  await registered.get('abap-smartfix.applyFile')({ resourceUri: activeDoc.uri });
  check('file button asks for confirmation first', messages.filter((m) => m[0] === 'warn').length > warnBefore);
  check('file button modifies after confirmation', !!appliedEdit && codeReplaces(appliedEdit).length === 2);
  appliedEdit = null;
  await registered.get('abap-smartfix.applyWorkspace')();
  const wsConfirm = messages.filter((m) => m[0] === 'warn').map((m) => m[1]).find((m) => /This will modify \d+ files?/.test(m));
  check('workspace fix lists file and finding counts', !!wsConfirm && /3 rewrites, \d+ annotations/.test(wsConfirm), wsConfirm);
  check('workspace fix is a single WorkspaceEdit', !!appliedEdit && appliedEdit.inserts.length > 0);
  appliedEdit = null;

  console.log('\n== Auto fix ==');
  await registered.get('abap-smartfix.applyFindings')(activeDoc.uri, { all: true });
  check('WorkspaceEdit created', !!appliedEdit && appliedEdit.inserts.length > 0,
    appliedEdit ? String(appliedEdit.inserts.length) : 'null');
  const insertText = appliedEdit.inserts.map((i) => i.text).join('|');
  check('inserts contain a pseudo comment', /"#EC /.test(insertText));
  check('inserts contain a pragma', /##NEEDED|##NO_HANDLER/.test(insertText));
  check('inserts contain the rewrite (UP TO 1 ROWS / ENDSELECT)', /UP TO 1 ROWS/.test(insertText) && /ENDSELECT\./.test(insertText));
  check('SINGLE is removed with a replace edit', codeReplaces(appliedEdit).length === 2 && codeReplaces(appliedEdit).every((r) => r.text === ''),
    String(appliedEdit.replaces.length));
  // UP TO 1 ROWS without ORDER BY is reported by ATC itself (SEL_UP_TO): the rewrite brings its "#EC CI_NOORDER along
  check('"#EC CI_NOORDER added with the rewrite to UP TO 1 ROWS', /"#EC CI_NOORDER/.test(insertText));
  check('insert positions are within the line length', appliedEdit.inserts.every(
    (i) => i.position.character <= activeDoc._lines[i.position.line].length
  ));

  console.log('\n== AI prompt ==');
  let clipboard = '';
  vscodeStub.env = { clipboard: { writeText: (t) => { clipboard = t; return Promise.resolve(); } } };
  await registered.get('abap-smartfix.copyAiPrompt')();
  check('AI prompt has content', clipboard.length > 500, String(clipboard.length));
  check('AI prompt has the per-line table', /\| Line \| Type \| Annotation \/ rewrite \|/.test(clipboard));
  check('AI prompt has the hard rules', /Only make the listed changes/.test(clipboard));
  check('AI prompt has a code rewrite row', /\| Code rewrite \| `SELECT SINGLE → SELECT … UP TO 1 ROWS … ENDSELECT[^`]*`/.test(clipboard));
  check('AI prompt has rewrite details', /#### Code rewrite details/.test(clipboard) &&
    /```abap\n\s*SELECT matnr FROM mara INTO ls_item-matnr UP TO 1 ROWS/.test(clipboard));
  check('AI prompt has the source', /```abap/.test(clipboard));
  check(
    'one pseudo comment per line (not merged)',
    /`"#EC CI_NOORDER`/.test(clipboard) &&
      !/"#EC \w+ "#EC/.test(clipboard),
    (clipboard.match(/\| `[^`]*#EC[^`]*` \|/) || [''])[0]
  );

  console.log('\n== Sidebar filled without a prior scan ==');
  for (const cmd of ['previewFix', 'applySuppressOnly', 'applyAll']) {
    await registered.get('abap-smartfix.clear')();
    const warnSeen = messages.length;
    const realWarn = vscodeStub.window.showWarningMessage;
    let listedWhenAsked = null;
    vscodeStub.window.showWarningMessage = (m) => {
      listedWhenAsked = view.provider.getChildren().length;
      messages.push(['warn', m]);
      return Promise.resolve(undefined); // cancel: results must still be listed
    };
    await registered.get('abap-smartfix.' + cmd)();
    vscodeStub.window.showWarningMessage = realWarn;
    check(cmd + ' lists the findings in the sidebar', view.provider.getChildren().length === 1);
    if (cmd !== 'previewFix') check(cmd + ': sidebar filled before the confirmation', listedWhenAsked === 1 && messages.length > warnSeen);
  }
  appliedEdit = null;

  console.log('\n== Unsaved edits ==');
  const savedDoc = activeDoc;
  await registered.get('abap-smartfix.scanFile')();
  activeDoc = makeDoc(savedDoc.fileName, '\n\n' + savedDoc.getText(), 2); // two lines inserted at the top
  const moved = vscodeStub._codeActionProvider.provideCodeActions(activeDoc, new Range(29, 0, 29, 1));
  check('Quick Fix after unsaved edits uses the current line numbers',
    moved.some((a) => a.command && a.command.arguments[1].line === 29), moved.map((a) => a.title).join(' | '));
  activeDoc = savedDoc;
  await registered.get('abap-smartfix.scanFile')();

  console.log('\n== Analyze while typing ==');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const selectSingleLabel = () => {
    const files = view.provider.getChildren();
    if (!files.length) return '';
    return String(view.provider.getChildren(files[0]).map((c) => c.label).find((l) => /Rewrite: SELECT SINGLE/.test(String(l))));
  };
  const typed = makeDoc(savedDoc.fileName, '\n\n' + savedDoc.getText(), 3); // two lines inserted at the top
  const type = () => changeListener({ document: typed, contentChanges: [{}] });
  check('change listener registered', typeof changeListener === 'function');
  check('before typing: SELECT SINGLE on L35', /^L35\s/.test(selectSingleLabel()), selectSingleLabel());
  type();
  await wait(300);
  type(); // still typing: the timer starts again
  await wait(300);
  check('not analyzed while typing continues', /^L35\s/.test(selectSingleLabel()), selectSingleLabel());
  await wait(350);
  check('analyzed about 0.5 s after typing stops', /^L37\s/.test(selectSingleLabel()), selectSingleLabel());

  await registered.get('abap-smartfix.clear')();
  type();
  await wait(600);
  check('after Clear Results the file is not analyzed while typing', view.provider.getChildren().length === 0);

  await registered.get('abap-smartfix.scanFile')();
  settings.scanOnType = false;
  type();
  await wait(600);
  check('scanOnType = false turns it off', /^L35\s/.test(selectSingleLabel()), selectSingleLabel());
  settings.scanOnType = true;

  console.log('\n== Diff preview comes back when a finding is opened ==');
  executed.length = 0;
  await registered.get('abap-smartfix.previewFix')();
  const previewCall = executed.find((a) => a[0] === 'vscode.diff');
  check('(precondition) preview diff opened', !!previewCall);
  const previewGroup = vscodeStub.window.tabGroups.all[0];
  previewGroup.viewColumn = 1;
  const previewTab = { input: { original: activeDoc.uri, modified: previewCall[2] }, isActive: false, label: 'demo.abap ↔ Auto Fix Preview', group: previewGroup };
  previewGroup.tabs = [previewTab];
  executed.length = 0;
  await registered.get('abap-smartfix.reveal')(activeDoc.uri, 30, 0);
  const reshown = executed.find((a) => a[0] === 'vscode.diff');
  check('hidden diff tab is shown again with original and preview',
    !!reshown && reshown[1] === activeDoc.uri && reshown[2] === previewCall[2] && reshown[4].viewColumn === 1);
  previewTab.isActive = true;
  executed.length = 0;
  await registered.get('abap-smartfix.reveal')(activeDoc.uri, 30, 0);
  check('diff tab already in front is not reopened', !executed.some((a) => a[0] === 'vscode.diff'));
  previewGroup.tabs = [];
  executed.length = 0;
  hideActiveEditor = true;
  await registered.get('abap-smartfix.reveal')(activeDoc.uri, 30, 0);
  hideActiveEditor = false;
  const reopened = executed.find((a) => a[0] === 'vscode.diff');
  check('no preview open: a sidebar click opens it (original left, preview right)',
    !!reopened && reopened[1] === activeDoc.uri && String(reopened[2]).indexOf('abap-smartfix-preview:') === 0);
  settings['preview.onReveal'] = false;
  executed.length = 0;
  await registered.get('abap-smartfix.reveal')(activeDoc.uri, 30, 0);
  delete settings['preview.onReveal'];
  check('preview.onReveal = false: a sidebar click only jumps to the line', !executed.some((a) => a[0] === 'vscode.diff'));

  console.log('\n== Close file ==');
  await registered.get('abap-smartfix.scanFile')();
  const fileTab = { input: { uri: activeDoc.uri } };
  const diffTab = { input: { original: activeDoc.uri, modified: { toString: () => 'abap-smartfix-preview:/demo.abap' } } };
  const groups = vscodeStub.window.tabGroups.all;
  check('tab listener registered', typeof tabListener === 'function');
  groups[0].tabs = [diffTab];
  tabListener({ opened: [], changed: [], closed: [fileTab] });
  check('file tab closed but still shown in the diff: findings kept', view.provider.getChildren().length === 1);
  groups[0].tabs = [];
  tabListener({ opened: [], changed: [], closed: [diffTab] });
  check('last tab closed: sidebar cleared', view.provider.getChildren().length === 0);
  check('last tab closed: Problems cleared', !diagStore.has(activeDoc.uri.toString()));

  console.log('\n== ATC mode: every fix entry point uses the ATC result (ADT sends no check class) ==');
  adtInstalled = true;
  settings['atc.enabled'] = true;
  const atcText = [
    'REPORT y_atc.',
    'DATA ls_dd02l TYPE dd02l.',
    'START-OF-SELECTION.',
    "SELECT * FROM dd02l INTO ls_dd02l UP TO 1 ROWS",
    "WHERE tabname = 'T685'. \"#EC CI_ALL_FIELDS_NEEDED",
    'ENDSELECT.',
    '',
  ].join('\n');
  const atcUri = {
    scheme: 'abap', fsPath: '\\repotree-v1\\DEV\\y_atc.prog.abap', path: '/repotree-v1/DEV/y_atc.prog.abap',
    toString() { return 'abap:/repotree-v1/DEV/y_atc.prog.abap'; },
  };
  const adtDiag = (line, id, message) => ({ source: 'ATC', code: 'undefined - ' + id, message, severity: 1, range: new Range(line - 1, 0, line - 1, 99) });
  atcResult = [adtDiag(4, 'SEL_UP_TO', 'SELECT .. UP TO .. ROWS without ORDER BY found')];
  const atcDoc = Object.assign(makeDoc('y_atc.prog.abap', atcText, 7), { uri: atcUri, isDirty: false });
  const entries = async (label, run) => {
    activeDoc = atcDoc;
    appliedEdit = null;
    atcRuns = 0;
    await registered.get('abap-smartfix.clear')();
    await run();
    const texts = appliedEdit ? appliedEdit.inserts.map((i) => i.text).concat(appliedEdit.replaces.map((r) => r.text)) : [];
    check(label + ': ATC is run and "#EC CI_NOORDER is added', atcRuns === 1 && texts.some((t) => /CI_NOORDER/.test(t)),
      'ATC runs ' + atcRuns + ', edits ' + JSON.stringify(texts));
  };
  await entries('sidebar file node (Auto Fix Checked Findings in This File)', () => registered.get('abap-smartfix.applyFile')({ resourceUri: atcUri }));
  await entries('editor Auto Fix', () => registered.get('abap-smartfix.applyAll')());
  await entries('Fix Findings in Selection', () => {
    quickPickAnswer = (items) => items;
    return registered.get('abap-smartfix.fixSelection')(atcUri, 3, 5);
  });
  quickPickAnswer = () => undefined;
  // The sidebar line is the one ATC reports
  activeDoc = atcDoc;
  await registered.get('abap-smartfix.scanFile')();
  const atcNodes = view.provider.getChildren(view.provider.getChildren()[0]);
  check('ATC finding listed on the reported line L4', atcNodes.some((n) => /^L4 {2}"#EC CI_NOORDER/.test(n.label)), atcNodes.map((n) => n.label).join());

  // Buffering is not in the source: learned from an ATC run, then used without ATC
  const joinText = [
    'REPORT y_atc.',
    'DATA lt TYPE STANDARD TABLE OF ekko.',
    'START-OF-SELECTION.',
    '  SELECT a~ebeln e~text1 INTO TABLE lt FROM ekko AS a',
    '    INNER JOIN t052u AS e ON a~zterm = e~zterm',
    "    WHERE a~bukrs = '1000'.",
    '  IF sy-subrc <> 0. ENDIF.',
    '',
  ].join('\n');
  const joinDoc = Object.assign(makeDoc('y_atc.prog.abap', joinText, 8), { uri: atcUri, isDirty: false });
  atcResult = [adtDiag(5, '0001', 'Buffered table T052U in a JOIN')];
  activeDoc = joinDoc;
  await registered.get('abap-smartfix.clear')();
  await registered.get('abap-smartfix.scanFile')();
  check('ATC run remembers the buffered table of the system',
    JSON.stringify((globalStore.get('abap-smartfix.atcFacts') || {}).DEV) === '{"buffered":{"T052U":"buffered"}}',
    JSON.stringify(globalStore.get('abap-smartfix.atcFacts')));
  settings['atc.enabled'] = false;
  appliedEdit = null;
  await registered.get('abap-smartfix.clear')();
  await registered.get('abap-smartfix.applyFindings')(joinDoc.uri, { all: true });
  const joinTexts = appliedEdit ? appliedEdit.inserts.map((i) => i.text).join('|') : '';
  check('without ATC the remembered buffered table gets "#EC CI_BUFFJOIN', /"#EC CI_BUFFJOIN/.test(joinTexts), joinTexts);
  adtInstalled = false;
  delete settings['atc.enabled'];

  fs.writeFileSync(path.join(__dirname, 'prompt-preview.md'), clipboard, 'utf8');
  console.log('\n(Sample AI prompt written to test/prompt-preview.md)');

  console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
