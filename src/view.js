'use strict';

const path = require('path');
const vscode = require('vscode');

const SEVERITY_ICON = {
  error: new vscode.ThemeIcon('error'),
  warning: new vscode.ThemeIcon('warning'),
  information: new vscode.ThemeIcon('info'),
};
const REWRITE_ICON = new vscode.ThemeIcon('wand');

// TreeItemCheckboxState exists from VS Code 1.80; without it the tree simply shows no checkboxes
const CHECKBOX = vscode.TreeItemCheckboxState;

function checkbox(checked, tooltip) {
  if (!CHECKBOX) return undefined;
  return { state: checked ? CHECKBOX.Checked : CHECKBOX.Unchecked, tooltip };
}

/** The ways a finding can be fixed, and its SCI check classes (sidebar tooltip, hover) */
function fixAlternatives(f) {
  const alt = [];
  if (f.rewrite) alt.push('Rewrite: ' + f.rewrite.summary + (f.rewrite.safety === 'review' ? ' (needs review)' : ''));
  if (f.canSuppress) alt.push('Annotation: `' + f.token + '`' + (f.tokenSource === 'setting' ? ' (from tokenOverrides)' : ''));
  if (f.sciClasses && f.sciClasses.length) alt.push('SCI: ' + f.sciClasses.join(', '));
  return alt;
}

class FindingsProvider {
  /**
   * @param {Map<string, {uri: vscode.Uri, text: string, result: object}>} store
   * @param {import('./selection').Selection} selection which findings are checked
   */
  constructor(store, selection) {
    this.store = store;
    this.selection = selection;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) return this.fileNodes();
    if (element.kind === 'file') return this.findingNodes(element.uriString);
    return [];
  }

  fileNodes() {
    const nodes = [];
    for (const [key, entry] of this.store) {
      const findings = entry.result.findings;
      const n = findings.length;
      if (!n) continue;
      const checked = this.selection.checkedOf(key, findings).length;
      const item = new vscode.TreeItem(
        path.basename(entry.uri.fsPath),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = key;
      item.description =
        n + (n === 1 ? ' finding' : ' findings') + (checked < n ? ' · ' + checked + ' checked' : '') +
        ' · ' + vscode.workspace.asRelativePath(entry.uri);
      item.resourceUri = entry.uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = 'abap-smartfix.file';
      item.checkboxState = checkbox(checked === n, 'Include all findings of this file in the auto fix');
      item.kind = 'file';
      item.uriString = key;
      nodes.push(item);
    }
    nodes.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return nodes;
  }

  findingNodes(key) {
    const entry = this.store.get(key);
    if (!entry) return [];
    return entry.result.findings.map((f) => {
      // ATC findings are shown on the line ATC reports, which can be inside a multi-line statement
      const line = f.line != null ? f.line : f.startLine;
      const item = new vscode.TreeItem(
        'L' + (line + 1) + '  ' + f.fixLabel,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = key + '\u0002' + f.key;
      item.description = f.title + (f.detail ? ' — ' + f.detail : '');
      item.iconPath =
        f.action === 'rewrite' ? REWRITE_ICON : SEVERITY_ICON[f.severity] || SEVERITY_ICON.information;
      const alt = fixAlternatives(f);
      // Code and ATC texts are shown, never run: no command links, no HTML, and a fence longer than any backticks in the code
      const fence = '`'.repeat(Math.max(3, ...(String(f.code).match(/`+/g) || []).map((b) => b.length + 1)));
      const tip = new vscode.MarkdownString();
      tip.isTrusted = false;
      tip.supportHtml = false;
      tip.appendText(f.fixLabel + ' — ' + f.title + (f.detail ? ' (' + f.detail + ')' : '') + '\n\n' + f.why + '\n\n' + alt.join(' · '));
      tip.appendMarkdown('\n\n' + fence + 'abap\n' + f.code + '\n' + fence + '\n\n');
      tip.appendText('Uncheck to leave it out of the auto fix.');
      item.tooltip = tip;
      item.checkboxState = checkbox(this.selection.isChecked(key, f.key), 'Include in the auto fix');
      item.contextValue = f.action === 'manual' ? 'abap-smartfix.finding.manual' : 'abap-smartfix.finding';
      item.kind = 'finding';
      item.finding = f;
      item.uriString = key;
      item.command = {
        command: 'abap-smartfix.reveal',
        title: 'Go to finding',
        // Another line of the statement: the column is the line's first code character (null)
        arguments: [entry.uri, line, line === f.startLine ? f.startCol : null],
      };
      return item;
    });
  }
}

module.exports = { FindingsProvider, fixAlternatives };
