'use strict';

/**
 * DDIC objects read from the SAP system through ABAP Development Tools for VS Code (SAP, extension sapse.adt-vscode).
 *
 * That extension serves the repository as the file system "abap". Besides the package tree
 * (abap:/repotree-v1/<destination>/System Library/<packages…>/Dictionary/Database Tables/ZSF_DEMO_MATERIAL/zsf_demo_material.tabl.ddic)
 * its language server has a flat view, abap:/flat/<destination>/<file name>, which loads an object by its name and type
 * alone, without knowing its package. Only that view is read here, read-only; nothing is written to the system.
 *
 * Without the extension, a logged-on destination or the object, a name stays unknown and the rules keep their
 * source-only behavior.
 */

const vscode = require('vscode');
const { parseTabl, parseTtyp } = require('./ddic');

const SCHEME = 'abap';
const READ_TIMEOUT_MS = 15000;
const MAX_PARALLEL = 4;
/** After the system could not be asked about a name, it is not asked again for this long */
const RETRY_AFTER_MS = 60000;

/** destination (upper case) → Map name (upper case) → info | null */
const cache = new Map();
/** 'DEST|NAME' → Promise, so one name is fetched once */
const pending = new Map();
/** 'DEST|NAME' → time of the last failed attempt */
const failedAt = new Map();

function mapFor(destination) {
  const d = String(destination).toUpperCase();
  if (!cache.has(d)) cache.set(d, new Map());
  return cache.get(d);
}

/**
 * The ADT destination of a document: abap:/repotree-v1/DEV/… or abap:/flat/DEV/… → DEV.
 * Other documents use the setting abap-smartfix.ddic.destination.
 */
function destinationOf(uri, configured) {
  if (uri && uri.scheme === SCHEME) {
    const seg = uri.path.split('/').filter(Boolean);
    if (seg.length >= 2) return seg[1];
  }
  return configured || '';
}

/** Whether ABAP Development Tools for VS Code is installed (its file system is registered when it activates) */
function adtAvailable() {
  return !!vscode.extensions.getExtension('sapse.adt-vscode');
}

/** AFF file name of an object: /NS/NAME → (ns)name */
function affName(name) {
  return String(name).toLowerCase().replace(/^\/([^/]+)\//, '($1)');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Names come from the source code: only DDIC / program names ([/NS/]NAME) and plain destination ids form a path
const VALID_NAME = /^(?:PROG:)?(?:\/[A-Z0-9_]{1,10}\/)?[A-Z0-9_]{1,40}$/i;
const VALID_DESTINATION = /^[A-Za-z0-9_.-]{1,64}$/;

async function readText(destination, fileName) {
  if (!VALID_DESTINATION.test(destination) || !/^(?:\([a-z0-9_]+\))?[a-z0-9_]+\.[a-z.]+$/.test(fileName)) {
    throw new Error('invalid name');
  }
  const uri = vscode.Uri.from({ scheme: SCHEME, path: '/flat/' + destination + '/' + fileName });
  const bytes = await withTimeout(Promise.resolve(vscode.workspace.fs.readFile(uri)), READ_TIMEOUT_MS);
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Read one name: database table / structure (.tabl.ddic), then table type (.ttypda.jsonc).
 * Resolves to info, null (neither exists) or undefined (the system could not be asked: not logged on, error, timeout).
 */
async function fetchOne(destination, name, log) {
  if (/^PROG:/i.test(name)) return fetchProgram(destination, name.slice(5), log);
  const base = affName(name);
  let reached = false;
  for (const [file, parser] of [[base + '.tabl.ddic', parseTabl], [base + '.ttypda.jsonc', parseTtyp]]) {
    try {
      const info = parser(await readText(destination, file), name);
      if (info) {
        if (log) {
          log('DDIC ' + destination + ' ' + String(name).toUpperCase() + ': ' + info.category +
            (info.keys && info.keys.length ? ' (key ' + info.keys.join(', ') + ')' : '') +
            (info.description ? ' "' + info.description + '"' : ''));
        }
        return info;
      }
      reached = true;
    } catch (e) {
      // FileNotFound: the system answered and there is no such object; anything else: unknown
      if (e && (e.code === 'FileNotFound' || /FileNotFound|EntryNotFound|not found|does not exist/i.test(String(e.message)))) reached = true;
      else if (log) log('DDIC ' + destination + ' ' + file + ': ' + (e && e.message ? e.message : e));
    }
  }
  return reached ? null : undefined;
}

/**
 * Whether a program exists (name as "PROG:<name>" in the cache): its source (<name>.prog.abap) has a REPORT / PROGRAM
 * statement → { category: 'program' }; FileNotFound or no source → null; not logged on, timeout, other errors → undefined.
 */
async function fetchProgram(destination, name, log) {
  const file = affName(name) + '.prog.abap';
  try {
    const text = await readText(destination, file);
    const exists = /^\s*(?:REPORT|PROGRAM)\b/im.test(text);
    if (log) log('DDIC ' + destination + ' program ' + String(name).toUpperCase() + (exists ? ' exists' : ' does not exist'));
    return exists ? { category: 'program' } : null;
  } catch (e) {
    if (e && (e.code === 'FileNotFound' || /FileNotFound|EntryNotFound|not found|does not exist/i.test(String(e.message)))) {
      if (log) log('DDIC ' + destination + ' program ' + String(name).toUpperCase() + ' does not exist');
      return null;
    }
    if (log) log('DDIC ' + destination + ' ' + file + ': ' + (e && e.message ? e.message : e));
    return undefined;
  }
}

// ---------------------------------------------------------------- ABAP release of the system

/**
 * The ABAP release is told by classes that came with a language feature (they are part of the kernel's ABAP and are not
 * downported): CL_ABAP_UTCLONG with the type UTCLONG (7.54, also += etc.), CX_SY_ITAB_LINE_NOT_FOUND with table expressions
 * (7.40 SP02, also NEW / REF / EXACT #( )). Without both it is 7.31 / 7.03: ADT cannot log on to older systems, so a system
 * read through ADT always has pragmas (7.02).
 */
const RELEASE_MARKERS = [['7.54', 'cl_abap_utclong'], ['7.40', 'cx_sy_itab_line_not_found']];
const OLDEST_ADT_RELEASE = '7.31';

/** destination (upper case) → detected release; 'DEST' → Promise; 'DEST' → time of the last failed attempt */
const releases = new Map();
const releasePending = new Map();
const releaseFailedAt = new Map();

/** Whether a class exists: true / false, throws when the system could not be asked */
async function classExists(destination, name) {
  try {
    const text = await readText(destination, name + '.clas.abap');
    return new RegExp('^\\s*CLASS\\s+' + name + '\\s+DEFINITION\\b', 'im').test(text);
  } catch (e) {
    if (e && (e.code === 'FileNotFound' || /FileNotFound|EntryNotFound|not found|does not exist/i.test(String(e.message)))) return false;
    throw e;
  }
}

/**
 * Detect the ABAP release of a destination once (cached for the session). Resolves to "7.54", "7.40", "7.31", or undefined when
 * the system could not be asked (no ADT, not logged on, timeout); then it is asked again after RETRY_AFTER_MS.
 */
async function detectRelease(destination, log) {
  if (!destination || !VALID_DESTINATION.test(destination) || !adtAvailable()) return undefined;
  const d = destination.toUpperCase();
  if (releases.has(d)) return releases.get(d);
  if (releasePending.has(d)) return releasePending.get(d);
  if (Date.now() - (releaseFailedAt.get(d) || 0) < RETRY_AFTER_MS) return undefined;
  const run = (async () => {
    try {
      let release = OLDEST_ADT_RELEASE;
      for (const [rel, cls] of RELEASE_MARKERS) {
        if (await classExists(destination, cls)) {
          release = rel;
          break;
        }
      }
      releases.set(d, release);
      if (log) log('ABAP release of ' + destination + ': ' + release + (release === '7.54' ? ' or later' : '') +
        ' (detected; set abap-smartfix.abapRelease to override)');
      return release;
    } catch (e) {
      releaseFailedAt.set(d, Date.now());
      if (log) log('ABAP release of ' + destination + ' could not be detected: ' + (e && e.message ? e.message : e));
      return undefined;
    } finally {
      releasePending.delete(d);
    }
  })();
  releasePending.set(d, run);
  return run;
}

/** The detected release of a destination, undefined while unknown */
function releaseOf(destination) {
  return destination ? releases.get(String(destination).toUpperCase()) : undefined;
}

async function runLimited(tasks, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  });
  await Promise.all(workers);
}

/**
 * Fetch the names not in the cache yet. Resolves to the number of names that became known (info or null),
 * so the caller analyzes the document again only when something changed.
 */
async function prefetch(destination, names, log) {
  if (!destination || !VALID_DESTINATION.test(destination) || !adtAvailable()) return 0;
  const map = mapFor(destination);
  const now = Date.now();
  const d = destination.toUpperCase();
  const todo = [...new Set(names.map((n) => String(n).toUpperCase()))]
    .filter((n) => VALID_NAME.test(n) && !map.has(n) && !(now - (failedAt.get(d + '|' + n) || 0) < RETRY_AFTER_MS));
  let learned = 0;
  await runLimited(todo.map((name) => async () => {
    const key = d + '|' + name;
    if (!pending.has(key)) pending.set(key, fetchOne(destination, name, log).finally(() => pending.delete(key)));
    const info = await pending.get(key);
    if (info === undefined) failedAt.set(key, Date.now());
    else if (!map.has(name)) {
      map.set(name, info);
      learned++;
    }
  }), MAX_PARALLEL);
  return learned;
}

/** The DDIC view (ddic.js) of a destination, or null without one */
function viewFor(destination) {
  if (!destination) return null;
  const map = mapFor(destination);
  return { get: (name) => (name ? map.get(String(name).toUpperCase()) : undefined) };
}

function clearCache() {
  cache.clear();
  failedAt.clear();
  releases.clear();
  releaseFailedAt.clear();
}

/**
 * Cached names per destination, for the log and as part of the analysis cache key (extension.js): a name learned not to
 * exist (null) changes findings too, so it is counted as well
 */
function cacheSummary() {
  return [...cache.entries()].map(([d, m]) => {
    const objects = [...m.values()].filter(Boolean).length;
    return d + ': ' + objects + ' objects, ' + (m.size - objects) + ' not found';
  }).join(', ');
}

module.exports = {
  destinationOf, adtAvailable, prefetch, viewFor, clearCache, cacheSummary, affName,
  detectRelease, releaseOf, OLDEST_ADT_RELEASE,
};
