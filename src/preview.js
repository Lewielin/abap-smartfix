'use strict';

const path = require('path');
const vscode = require('vscode');

const { applyEditsToText } = require('./fixer');

const PREVIEW_SCHEME = 'abap-smartfix-preview';

/**
 * The diff preview: the original on the left, the auto-fixed code on the right, without touching the file. Also the
 * TextDocumentContentProvider of the fixed side (scheme abap-smartfix-preview).
 */
class Preview {
  /**
   * @param {object} host
   * @param {(doc: vscode.TextDocument, mode: string|null) => {picked: object[], plan: object}} host.plan the fixes of the checked findings
   * @param {(doc: vscode.TextDocument, plan: object) => void} host.logUnfixable
   * @param {() => void} host.showOutput
   * @param {(uri?: vscode.Uri) => vscode.WorkspaceConfiguration} host.cfg
   * @param {(msg: string) => void} host.log
   */
  constructor(host) {
    this.host = host;
    /** @type {Map<string, {uri: vscode.Uri, source: string, mode: string|null, text: string}>} preview uri -> content */
    this.content = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  provideTextDocumentContent(uri) {
    const p = this.content.get(uri.toString());
    return p ? p.text : '';
  }

  /** The uri of the file a preview document shows, or '' for any other document */
  sourceOf(uri) {
    const p = this.content.get(uri.toString());
    return p ? p.source : '';
  }

  /** The tab showing a preview was closed */
  forget(key) {
    this.content.delete(key);
  }

  /** Recompute open previews of the document, e.g. after fixes were applied or the file was saved */
  refresh(doc) {
    const key = doc.uri.toString();
    for (const p of this.content.values()) {
      if (p.source !== key) continue;
      p.text = applyEditsToText(doc.getText(), this.host.plan(doc, p.mode).plan.edits);
      this._onDidChange.fire(p.uri);
    }
  }

  /**
   * Open the diff preview. quiet: opened from the sidebar, without messages when there is nothing to preview.
   * Returns the fixed text, or null when nothing was opened.
   */
  async open(doc, mode, quiet) {
    const { picked, plan } = this.host.plan(doc, mode);
    if (!picked.length) {
      if (!quiet) vscode.window.showInformationMessage('Nothing to fix.');
      return null;
    }
    // A diff without changes shows no red / green at all: say why instead of opening it
    if (!plan.edits.length) {
      if (quiet) return null;
      const manual = plan.unfixable.reduce((n, u) => n + u.findings.length, 0);
      this.host.logUnfixable(doc, plan);
      vscode.window.showInformationMessage('No automatic changes to preview: ' + manual + ' finding' + (manual === 1 ? '' : 's') +
        ' need manual fixing (see the Output panel).');
      this.host.showOutput();
      return null;
    }
    const fixed = applyEditsToText(doc.getText(), plan.edits);
    const name = path.basename(doc.fileName);
    const puri = vscode.Uri.parse(
      PREVIEW_SCHEME + ':/' + encodeURIComponent(name) + '?' + encodeURIComponent(doc.uri.toString())
    );
    this.content.set(puri.toString(), { uri: puri, source: doc.uri.toString(), mode: mode || null, text: fixed });
    this._onDidChange.fire(puri);
    await this.ensureSideBySide();
    // In the editor group that shows the file, not beside it; pinned (preview: false), so opening a finding does not replace it
    const key = doc.uri.toString();
    const shown = (vscode.window.visibleTextEditors || []).find((e) => e.document.uri.toString() === key);
    const options = { preview: false };
    if (shown && shown.viewColumn) options.viewColumn = shown.viewColumn;
    await vscode.commands.executeCommand('vscode.diff', doc.uri, puri, name + ' ↔ Auto Fix Preview', options);
    await this.makeRoom();
    return fixed;
  }

  /**
   * Give the preview more room: close the secondary side bar. The bottom panel, other editor groups and the SmartFix for ABAP
   * sidebar (its findings go with the preview) stay. abap-smartfix.preview.closeSecondarySideBar turns it off.
   */
  async makeRoom() {
    if (!this.host.cfg().get('preview.closeSecondarySideBar', true)) return;
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    } catch (e) {
      this.host.log('Preview: the secondary side bar could not be closed: ' + (e && e.message ? e.message : e));
    }
  }

  /** Show the file itself instead of its diff preview, e.g. once the fixes it shows are applied */
  async close(doc) {
    const tab = this.findTab(doc.uri.toString());
    if (!tab || !vscode.window.tabGroups.close) return;
    try {
      // The file's own tab first, so closing the diff never closes the (unsaved) file
      await vscode.window.showTextDocument(doc, { viewColumn: tab.group.viewColumn, preview: false });
      await vscode.window.tabGroups.close(this.findTab(doc.uri.toString()) || tab);
    } catch (e) {
      this.host.log('Preview could not be closed: ' + (e && e.message ? e.message : e));
    }
  }

  /** Whether the diff preview of the file is the tab in front */
  isActive(sourceKey) {
    const tab = this.findTab(sourceKey);
    return !!(tab && tab.isActive);
  }

  /**
   * Side by side: the original on the left, the preview on the right. VS Code shows a diff inline when it is off or when the
   * editor is narrow; abap-smartfix.preview.sideBySide (default on) turns both off in the user settings, once.
   */
  async ensureSideBySide() {
    if (!this.host.cfg().get('preview.sideBySide', true)) return;
    const de = vscode.workspace.getConfiguration('diffEditor');
    try {
      if (de.get('renderSideBySide') === false) await de.update('renderSideBySide', true, vscode.ConfigurationTarget.Global);
      if (de.get('useInlineViewWhenSpaceIsLimited') !== false) {
        await de.update('useInlineViewWhenSpaceIsLimited', false, vscode.ConfigurationTarget.Global);
        this.host.log('Preview: diffEditor.useInlineViewWhenSpaceIsLimited set to false, so the preview stays side by side ' +
          '(turn off abap-smartfix.preview.sideBySide to keep your own diff settings).');
      }
    } catch (e) {
      this.host.log('Preview: could not set the diff editor to side by side: ' + (e && e.message ? e.message : e));
    }
  }

  /** The editor of the file inside its diff preview (the left side), waiting briefly for VS Code to show it */
  async originalSideOf(key, tab) {
    for (let i = 0; i < 20; i++) {
      const ed = (vscode.window.visibleTextEditors || []).find((e) =>
        e.document.uri.toString() === key && (!tab || e.viewColumn === tab.group.viewColumn));
      if (ed) return ed;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  /** The still open diff preview tab of a file, if any */
  findTab(sourceKey) {
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        const input = t.input;
        if (!input || !input.original || !input.modified) continue;
        const p = this.content.get(input.modified.toString());
        if (p && p.source === sourceKey && input.original.toString() === sourceKey) return t;
      }
    }
    return null;
  }

  /**
   * Bring an open diff preview of the file back to the front (e.g. after switching to the plain file tab),
   * so both the original and the preview are shown. Returns the diff tab, or null when there is none.
   */
  async showDiff(sourceKey) {
    const tab = this.findTab(sourceKey);
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
}

module.exports = { Preview, PREVIEW_SCHEME };
