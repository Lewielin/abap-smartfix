'use strict';

const path = require('path');
const vscode = require('vscode');

const Atc = require('./atc');
const DdicAdt = require('./ddic-adt');

const ADT_EXTENSION = 'sapse.adt-vscode';
const FACTS_KEY = 'abap-smartfix.atcFacts';
const ATC_TIMEOUT_MS = 180000;
const SAVE_AND_RUN = 'Save and Run ATC';
/** Picking a check variant in ADT's quick pick (runWithVariant): time for it to open, for the paste, accept retries */
const VARIANT_OPEN_MS = 800;
const VARIANT_PASTE_MS = 300;
const VARIANT_ACCEPT_TRIES = 3;
const VARIANT_RETRY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ATC in the SAP system through ABAP Development Tools for VS Code: runs it on a document, remembers per document which
 * findings ATC confirms (atc.js), and what ATC told about the system (buffered tables, per destination).
 */
class AtcRunner {
  /**
   * @param {object} host
   * @param {(uri?: vscode.Uri) => vscode.WorkspaceConfiguration} host.cfg
   * @param {(msg: string) => void} host.log
   * @param {vscode.Memento} [host.globalState] where the facts of each system are remembered
   * @param {(doc: vscode.TextDocument) => object} host.analyze analysis of the document text, without ATC
   * @param {{findTab: (key: string) => object|null, showDiff: (key: string) => Promise}} host.preview
   */
  constructor(host) {
    this.host = host;
    /** Per document: the match of the last ATC run { version, variant, confirmed, unconfirmed, unmatched } (atc.js) */
    this.states = new Map();
    /** Per document: the version whose "save and run ATC" was declined, so it is not asked again for it */
    this.saveDeclined = new Map();
    this.loggedAdtVersion = false;
  }

  // ---------------------------------------------------------------- settings

  /** abap-smartfix.atc.enabled: whether ATC results from ADT are used (uri: the document's scope, or the global setting) */
  switchedOn(uri) {
    return this.host.cfg(uri).get('atc.enabled', true);
  }

  /** abap-smartfix.atc.checkVariant: { name, error }, name '' for the system's default check variant (atc.js) */
  variant(uri) {
    return Atc.checkVariantOf(this.host.cfg(uri).get('atc.checkVariant', 'DEFAULT'));
  }

  /** abap-smartfix.atc.checkVariantDelay: ms the variant search in ADT's quick pick is given before the first match is taken */
  variantDelay(uri) {
    const ms = Number(this.host.cfg(uri).get('atc.checkVariantDelay', 2000));
    return Number.isFinite(ms) ? Math.min(Math.max(ms, 500), 30000) : 2000;
  }

  /** Why ATC results cannot be used for this document, or '' when they can */
  offReason(doc) {
    if (!this.switchedOn(doc.uri)) return 'ATC results from ADT are switched off';
    if (doc.uri.scheme !== 'abap') return doc.fileName + ' is not opened from ABAP Development Tools (scheme ' + doc.uri.scheme + ')';
    if (!vscode.extensions.getExtension(ADT_EXTENSION)) return 'ABAP Development Tools for VS Code is not installed';
    return '';
  }

  enabled(doc) {
    return !this.offReason(doc);
  }

  // ---------------------------------------------------------------- per document

  /** The match of the last ATC run of the document, if any */
  state(key) {
    return this.states.get(key);
  }

  /** Apply the last ATC result of the document (if any) to an analysis of it */
  applyTo(result, doc, opts) {
    const state = this.states.get(doc.uri.toString());
    // The ATC result of the last explicit Analyze stays in use until the next one (also after switching ATC off)
    if (state) Atc.applyAtc(result, state, state.version === doc.version, opts);
    return result;
  }

  /** Follow the lines ATC checked, so each ATC finding stays with its statement after a fix, an undo or typing */
  trackChanges(key, contentChanges) {
    const state = this.states.get(key);
    if (state) Atc.trackChanges(state, contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, text: c.text })));
  }

  forget(key) {
    this.states.delete(key);
    this.saveDeclined.delete(key);
  }

  // ---------------------------------------------------------------- what ATC told about the system

  /** Destination of a document for remembered ATC facts: its ADT destination, or the configured one */
  factsDestination(uri) {
    return String(DdicAdt.destinationOf(uri, this.host.cfg(uri).get('ddic.destination', '')) || '').toUpperCase();
  }

  /** Buffered tables: the ones ATC reported for this system, plus abap-smartfix.bufferedTables (upper case, sorted) */
  bufferedTables(uri) {
    const own = this.host.cfg(uri).get('bufferedTables', []) || [];
    const gs = this.host.globalState;
    const facts = gs ? gs.get(FACTS_KEY, {}) : {};
    const learned = Object.keys(((facts[this.factsDestination(uri)] || {}).buffered) || {});
    return [...new Set(own.concat(learned).map((t) => String(t).toUpperCase()))].sort();
  }

  /** Remember the buffered tables an ATC run reported, so the source rules know them without ATC */
  async rememberFacts(doc, findings) {
    const dest = this.factsDestination(doc.uri);
    const gs = this.host.globalState;
    if (!gs || !dest) return;
    const found = Atc.factsFrom(findings).buffered;
    const facts = gs.get(FACTS_KEY, {});
    const mine = Object.assign({ buffered: {} }, facts[dest]);
    const added = Object.keys(found).filter((t) => mine.buffered[t] !== found[t]);
    if (!added.length) return;
    mine.buffered = Object.assign({}, mine.buffered, found);
    await gs.update(FACTS_KEY, Object.assign({}, facts, { [dest]: mine }));
    this.host.log('ATC: remembered buffered tables of ' + dest + ': ' + added.map((t) => t + ' (' + found[t] + ')').join(', '));
  }

  // ---------------------------------------------------------------- running ATC

  /**
   * Before a fix from the sidebar, a selection or the whole workspace: run ATC first when it is switched on, so the fix
   * uses what ATC reports (as Analyze / Auto Fix do). With ATC off the last ATC result of an Analyze stays in use.
   */
  async ensure(doc) {
    if (this.switchedOn(doc.uri)) await this.run(doc);
  }

  /**
   * Run ATC on the document in the SAP system through ABAP Development Tools for VS Code (the same as its "Run ATC" command,
   * with the system's default check variant or the one of abap-smartfix.atc.checkVariant) and remember which findings ATC
   * confirms. Only for saved objects opened from ADT; when ATC cannot be run, fails, times out or reports nothing, the
   * findings are decided from the source as before.
   * @returns {Promise<boolean>} whether an ATC result is in use for this version
   */
  async run(doc) {
    const log = this.host.log;
    const key = doc.uri.toString();
    const off = this.offReason(doc);
    if (off) {
      // Analyze with ATC switched off: back to the findings of the source
      if (this.switchedOn(doc.uri)) log('ATC not run: ' + off + '; findings are decided from the source.');
      this.states.delete(key);
      return false;
    }
    const known = this.states.get(key);
    const variant = this.variant(doc.uri);
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
      if (this.saveDeclined.get(key) === doc.version) return !!known;
      const pick = await vscode.window.showInformationMessage(
        'SmartFix for ABAP: ' + path.basename(doc.fileName) + ' has unsaved changes. ATC checks the version in the SAP system; ' +
          'save the file and run ATC on it?',
        SAVE_AND_RUN, 'Not Now'
      );
      if (pick !== SAVE_AND_RUN || !(await doc.save()) || doc.isDirty) {
        this.saveDeclined.set(key, doc.version);
        log('ATC not run: ' + doc.fileName + ' has unsaved changes; the last ATC result stays in use.');
        return !!known;
      }
      if (current()) return true;
    }
    const version = doc.version;
    // ADT runs ATC on the active editor, so the file comes to the front; an open diff preview is brought back afterwards
    const diff = this.host.preview.findTab(key);
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
            ? this.runWithVariant(doc, variant.name, this.variantDelay(doc.uri))
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
      if (diffWasActive) await this.host.preview.showDiff(key);
    }
    if (doc.version !== version) return !!known;
    const findings = Atc.readAtcDiagnostics(vscode.languages.getDiagnostics(doc.uri));
    await this.rememberFacts(doc, findings);
    // No findings: ATC found nothing in this version. That is a result too: findings of the checks ATC runs are hidden,
    // and this version is not checked again by the next command
    if (!findings.length) log('ATC reported no findings for ' + doc.fileName + '.');
    const m = Atc.matchAtc(this.host.analyze(doc), findings);
    this.states.set(key, Object.assign({ version, variant: variant.name }, m));
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
   * pick that searches the system as you type, and ADT exports no API to pass one (checked up to ADT for VS Code 1.1.2,
   * see tools/check-adt-atc-api.js). VS Code has no command that types into a quick pick, so the name is pasted through the
   * clipboard (its text is put back afterwards) and the first match is accepted once the search had delayMs to answer, a
   * few more times while nothing matched yet. When that does not work the quick pick stays open with the name filled in,
   * to pick by hand.
   * @returns {Promise} settles when ADT's command has finished
   */
  runWithVariant(doc, name, delayMs) {
    this.logAdtVersion();
    let done = false;
    const run = Promise.resolve(vscode.commands.executeCommand('adt-vscode.runAtcOnObjectWithVariant'));
    run.then(() => { done = true; }, () => { done = true; });
    this.pickVariant(doc, name, delayMs, () => done).catch((e) =>
      this.host.log('ATC: check variant ' + name + ' could not be picked (' + (e && e.message ? e.message : e) + '); pick it in the open list.'));
    return run;
  }

  async pickVariant(doc, name, delayMs, done) {
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

  /** Once per session: the ADT version the check variant is picked with, so a log shows it when a new ADT changes the list */
  logAdtVersion() {
    if (this.loggedAdtVersion) return;
    this.loggedAdtVersion = true;
    const adt = vscode.extensions.getExtension(ADT_EXTENSION);
    const version = adt && adt.packageJSON ? adt.packageJSON.version : 'unknown';
    this.host.log('ATC: check variant picked through the variant list of ABAP Development Tools for VS Code ' + version + '.');
  }
}

module.exports = { AtcRunner, SAVE_AND_RUN };
