'use strict';

const vscode = require('vscode');

const { fixAlternatives } = require('./view');

/**
 * Hover on a statement with findings: why it is reported and how it can be fixed, without opening the sidebar.
 * Only for files that were analyzed (abap-smartfix.hover turns it off).
 */
class FindingHoverProvider {
  /**
   * @param {object} host
   * @param {(doc: vscode.TextDocument) => {result: object}|undefined} host.entryFor the findings of an analyzed document, up to date
   * @param {(uri?: vscode.Uri) => vscode.WorkspaceConfiguration} host.cfg
   */
  constructor(host) {
    this.host = host;
  }

  provideHover(doc, position) {
    if (!this.host.cfg(doc.uri).get('hover', true)) return null;
    const entry = this.host.entryFor(doc);
    if (!entry) return null;
    const line = position.line;
    const here = entry.result.findings.filter((f) => f.startLine <= line && line <= f.endLine);
    if (!here.length) return null;
    return new vscode.Hover(hoverText(here), doc.lineAt(line).range);
  }
}

/** Code and ATC texts are shown as plain text, never run: no command links, no HTML */
function hoverText(findings) {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  findings.forEach((f, i) => {
    if (i) md.appendMarkdown('\n\n---\n\n');
    md.appendMarkdown('**SmartFix for ABAP:** ');
    md.appendText(f.fixLabel + '\n\n' + f.title + (f.detail ? ' (' + f.detail + ')' : '') + '\n\n' + f.why);
    const alt = fixAlternatives(f);
    if (alt.length) md.appendText('\n\n' + alt.join(' · '));
  });
  return md;
}

module.exports = { FindingHoverProvider, hoverText };
