'use strict';

/**
 * Checks whether a new version of ABAP Development Tools for VS Code lets SmartFix for ABAP run ATC with a check variant
 * directly, without pasting the name into ADT's variant list (src/atc-runner.js, runWithVariant).
 * Up to ADT 1.1.2 neither ATC command takes an argument and the extension exports no API.
 *
 * Run after ADT for VS Code is updated:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" tools\check-adt-atc-api.js [<ADT extension folder>]
 * Exit code 1: something changed; look at the lines marked CHANGED.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The ATC commands as of ADT 1.1.2, both without parameters */
const KNOWN = ['adt-vscode.runAtcOnObject', 'adt-vscode.runAtcOnObjectWithVariant'];

function adtFolder() {
  if (process.argv[2]) return process.argv[2];
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  const found = fs.readdirSync(dir).filter((d) => /^sapse\.adt-vscode-\d/.test(d)).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  if (!found.length) throw new Error('ABAP Development Tools for VS Code is not installed in ' + dir);
  return path.join(dir, found[found.length - 1]);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parameters of the command's handler in the bundle: '' for none, null when it cannot be found */
function handlerParams(bundle, id) {
  const names = ['"' + escape(id) + '"'];
  const alias = new RegExp('([\\w$]+)="' + escape(id) + '"').exec(bundle);
  if (alias) names.push(escape(alias[1]));
  const m = new RegExp('registerCommand\\((?:' + names.join('|') + '),\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|([\\w$]+))\\s*=>').exec(bundle);
  return m ? (m[1] != null ? m[1] : m[2]).trim() : null;
}

function main() {
  const folder = adtFolder();
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const bundle = fs.readFileSync(path.join(folder, pkg.main || 'dist/extension.js'), 'utf8');
  console.log('ABAP Development Tools for VS Code ' + pkg.version + ' (' + folder + ')');
  let changed = false;

  const atcCommands = ((pkg.contributes || {}).commands || []).map((c) => c.command).filter((c) => /atc/i.test(c));
  for (const id of atcCommands) {
    const params = handlerParams(bundle, id);
    const isNew = KNOWN.indexOf(id) < 0;
    const takesArgs = params == null || params !== '';
    if (isNew || takesArgs) changed = true;
    console.log((isNew || takesArgs ? '  CHANGED ' : '  same    ') + id + ': ' +
      (params == null ? 'handler not found, look at it by hand' : params ? 'takes (' + params + ')' : 'takes no arguments') +
      (isNew ? ' (new command)' : ''));
  }
  for (const id of KNOWN.filter((k) => atcCommands.indexOf(k) < 0)) {
    changed = true;
    console.log('  CHANGED ' + id + ': no longer contributed');
  }

  console.log(changed
    ? 'Something changed: check whether a check variant can now be passed directly (src/atc-runner.js, runWithVariant).'
    : 'Nothing changed: the check variant is still picked through ADT\'s variant list.');
  process.exitCode = changed ? 1 : 0;
}

main();
