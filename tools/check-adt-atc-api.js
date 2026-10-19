'use strict';

/**
 * Checks whether a new version of ABAP Development Tools for VS Code changed what SmartFix for ABAP relies on to run ATC
 * (src/atc-runner.js) and read its result (src/atc.js, readAtcDiagnostics):
 *   - the ATC commands: up to ADT 1.1.2 neither takes an argument; from 1.2.0 both take the objects to check (...args),
 *     the check variant is still picked in ADT's variant list (runWithVariant), and the extension exports no API;
 *   - the code of an ATC diagnostic: from 1.2.0 "<check class> - <message id>" only when both are there, else the one that
 *     is or "Finding", " - <n>" for a finding repeated on a line, and the ATC finding itself on the diagnostic (atcFinding).
 *
 * Run after ADT for VS Code is updated:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" tools\check-adt-atc-api.js [<ADT extension folder>]
 * Exit code 1: something changed; look at the lines marked CHANGED.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The ATC commands as of ADT 1.2.0 and their parameters: 'rest' (...args), 'one' (arg) or 'none' */
const KNOWN = {
  'adt-vscode.runAtcOnObject': 'rest',
  'adt-vscode.runAtcOnObjectWithVariant': 'rest',
  'adt-vscode.requestAtcExemption': 'one',
};

/** Parameters without their names, which change with every build of the bundle */
function shapeOf(params) {
  if (params === '') return 'none';
  if (/^\.\.\.[\w$]+$/.test(params)) return 'rest';
  if (/^[\w$]+$/.test(params)) return 'one';
  return params;
}

/** How ADT 1.2.0 writes the code of an ATC diagnostic (the parts of the bundle that stay in a new build) */
const CODE_FORMAT = [/\|\|"Finding"/, /\.source="ATC"/, /\.atcFinding=/];

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
    const isNew = !KNOWN[id];
    const other = params == null || shapeOf(params) !== KNOWN[id];
    if (isNew || other) changed = true;
    console.log((isNew || other ? '  CHANGED ' : '  same    ') + id + ': ' +
      (params == null ? 'handler not found, look at it by hand' : params ? 'takes (' + params + ')' : 'takes no arguments') +
      (isNew ? ' (new command)' : ''));
  }
  for (const id of Object.keys(KNOWN).filter((k) => atcCommands.indexOf(k) < 0)) {
    changed = true;
    console.log('  CHANGED ' + id + ': no longer contributed');
  }
  const codeSame = CODE_FORMAT.every((re) => re.test(bundle));
  if (!codeSame) changed = true;
  console.log((codeSame ? '  same    ' : '  CHANGED ') + 'code of ATC diagnostics' +
    (codeSame ? '' : ': look at convertFindingsToDiagnostics by hand'));

  console.log(changed
    ? 'Something changed: check how ATC is run and read (src/atc-runner.js run / runWithVariant, src/atc.js parseAtcCode).'
    : 'Nothing changed: ATC is run and read as with ADT 1.2.0; the check variant is still picked through ADT\'s variant list.');
  process.exitCode = changed ? 1 : 0;
}

main();
