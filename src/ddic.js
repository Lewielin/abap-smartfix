'use strict';

/**
 * DDIC information read from the SAP system (see ddic-adt.js) and what the rules need from it.
 *
 * Sources, as ABAP Development Tools for VS Code returns them:
 *   <name>.tabl.ddic     define table <name> { key mandt : mandt not null; … }  or  define structure <name> { … }
 *   <name>.ttypda.jsonc  { "name": "ZSF_DEMO_RET_T", "type": "TTYP/DA", … }  (table types have no source view in ADT for VS Code)
 *
 * A DDIC view is an object with get(name) → info | null | undefined:
 *   info       { category: 'table' | 'structure' | 'tabletype', keys?: string[], clientKey?: string, keysComplete?: boolean }
 *   null       the name was looked up and is no such DDIC object
 *   undefined  not looked up (no ADT connection, not fetched yet): the rules keep their source-only behavior
 */

const { parse } = require('./lexer');

const CLIENT_TYPES = /^(?:MANDT|CLNT|S_MANDT|RCLNT)$/;

/** Strip comments (// … and /* … *\/) of the DDL source */
function stripDdlComments(text) {
  return String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * define table / define structure → { category, keys, clientKey, keysComplete }.
 * keys are the key fields in upper case; clientKey is the client field among them (MANDT …), or ''.
 * An included key structure (key include …) cannot be expanded here, so keysComplete is false then.
 */
function parseTabl(text, expectedName) {
  const src = stripDdlComments(text);
  const head = src.match(/\bdefine\s+(table|structure)\s+([^\s{]+)/i);
  if (!head) return null;
  if (expectedName && head[2].toUpperCase() !== String(expectedName).toUpperCase()) return null;
  const category = head[1].toLowerCase() === 'table' ? 'table' : 'structure';
  const keys = [];
  let clientKey = '';
  let keysComplete = true;
  // Key fields start a line (… with foreign key t006 / foreignKey.keyType : #KEY are not key fields)
  const re = /^[ \t]*key\s+(include\s+)?([\w\/]+)\s*(?::\s*([\w\/]+))?/gim;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) { keysComplete = false; continue; }
    const field = m[2].toUpperCase();
    keys.push(field);
    const type = (m[3] || '').toUpperCase();
    if (!clientKey && keys.length === 1 && (CLIENT_TYPES.test(type) || /^(?:MANDT|CLIENT)$/.test(field))) clientKey = field;
  }
  // Fields (name : type); included structures are not expanded, so fieldCount is a lower bound when hasIncludes
  const fields = (src.match(/^[ \t]*(?:key\s+)?[\w\/]+\s*:\s*[\w\/]+/gim) || [])
    .map((l) => l.replace(/^[ \t]*(?:key\s+)?/i, '').split(/\s*:/)[0].toUpperCase());
  const fieldCount = fields.length;
  const hasIncludes = /^[ \t]*(?:key\s+)?include\s+/im.test(src);
  // fields: every column when there is no include (then a name that is not one of them is not a column)
  const info = { category, keys, clientKey, keysComplete, fieldCount, hasIncludes, fields };
  if (category === 'table' && !keys.length) info.keysComplete = false;
  return info;
}

/**
 * Table type metadata (JSON with // comments) → { category: 'tabletype' }, or null.
 * ADT for VS Code builds this file for any <name>.ttypda.jsonc it is asked for, so it only counts when it describes an
 * existing table type: type TTYP, the requested name, and a description (mandatory for table types in the DDIC).
 */
function parseTtyp(text, expectedName) {
  const src = String(text || '').replace(/^\s*\/\/[^\n]*$/gm, '');
  let obj;
  try {
    obj = JSON.parse(src);
  } catch (e) {
    return null;
  }
  if (!obj || !/^TTYP\b/i.test(String(obj.type || ''))) return null;
  if (expectedName && String(obj.name || '').toUpperCase() !== String(expectedName).toUpperCase()) return null;
  if (!String(obj.description || '').trim()) return null;
  return { category: 'tabletype', description: String(obj.description).trim() };
}

/** A DDIC view over a Map name (upper case) → info | null */
function viewOf(map) {
  return { get: (name) => (map && name ? map.get(String(name).toUpperCase()) : undefined) };
}

const BUILTIN_TYPES = /^(?:I|INT1|INT2|INT4|INT8|F|P|C|N|D|T|X|STRING|XSTRING|DECFLOAT16|DECFLOAT34|UTCLONG|ABAP_BOOL|ABAP_BOOLEAN|BOOLEAN|FLAG|DATA|ANY|SIMPLE|CLIKE|CSEQUENCE|XSEQUENCE|NUMERIC|OBJECT)$/;

/** Whether a type name can be a DDIC object: not built in, not a component (a-b), class type (c=>t) or system field */
function isDdicCandidate(name) {
  const n = String(name || '').toUpperCase();
  return /^(?:\/\w+\/)?[A-Z][\w]*$/.test(n) && !BUILTIN_TYPES.test(n) && n.length <= 30;
}

/**
 * Names the rules could use DDIC information for:
 *   types   typings of VALUE( ) parameters of METHODS that this file does not declare (table type or structure?)
 *   tables  database tables of SELECT SINGLE (primary key)
 *   programs  programs called by SUBMIT (whether they exist)
 */
function ddicRequests(text) {
  const statements = parse(text).statements;
  const local = new Set();
  for (const s of statements) {
    const m = s.upper.match(/^(?:CLASS-)?TYPES\s+(?:BEGIN\s+OF\s+)?([^\s,.]+)/);
    if (m) local.add(m[1]);
  }
  const types = new Set();
  const tables = new Set();
  const programs = new Set();
  for (const s of statements) {
    const u = s.upper;
    // SUBMIT of a static program name: does it exist in the system (submit-missing-program)?
    const sub = u.match(/^SUBMIT\s+([A-Z_\/][\w\/]*)(?=\s|$)/);
    if (sub) programs.add(sub[1]);
    if (/^(?:CLASS-)?METHODS\s/.test(u)) {
      // RETURNING parameters are not reported by ATC (value-param-table), so their types are not needed
      const params = u.replace(/\bRETURNING\b[\s\S]*?(?=\bRAISING\b|\bEXCEPTIONS\b|$)/, ' ');
      const re = /\bVALUE\([^)]+\)\s+TYPE\s+([^\s]+)/g;
      let m;
      while ((m = re.exec(params)) !== null) {
        const name = m[1];
        if (!local.has(name) && isDdicCandidate(name)) types.add(name);
      }
    }
    const t = selectSingleTable(u) || selectStarTable(u);
    if (t) tables.add(t);
    if (/^SELECT\s+SINGLE\b/.test(u)) for (const j of joinTables(u)) tables.add(j.table);
    // CLIENT SPECIFIED → USING CLIENT: the columns tell a column from a data object declared in another include
    const cs = /^SELECT\b/.test(u) && !/\bJOIN\b/.test(u) && u.match(/\bFROM\s+([^\s(@]+)\s+CLIENT\s+SPECIFIED\b/);
    if (cs && isDdicCandidate(cs[1])) tables.add(cs[1]);
  }
  return { types: [...types], tables: [...tables], programs: [...programs] };
}

/** Database table of SELECT SINGLE … FROM dbtab (one table, no JOIN, no dynamic or @itab source), or '' */
function selectSingleTable(u) {
  if (!/^SELECT\s+SINGLE\b/.test(u) || /\bJOIN\b/.test(u)) return '';
  const m = u.match(/\bFROM\s+([^\s(@]+)/);
  return m && isDdicCandidate(m[1]) ? m[1] : '';
}

/** Database table of SELECT [SINGLE] * FROM dbtab / SELECT FROM dbtab FIELDS * (one table, no JOIN), or '' */
function selectStarTable(u) {
  if (/\bJOIN\b/.test(u)) return '';
  const m = u.match(/^SELECT\s+(?:SINGLE\s+)?(?:DISTINCT\s+)?\*\s+FROM\s+([^\s(@]+)/) ||
    u.match(/^SELECT\s+(?:SINGLE\s+)?FROM\s+([^\s(@]+)\s+FIELDS\s+\*/) ||
    // Classic order with INTO before FROM: SELECT * INTO [CORRESPONDING FIELDS OF] TABLE itab FROM dbtab
    u.match(/^SELECT\s+(?:SINGLE\s+)?(?:DISTINCT\s+)?\*\s+(?:INTO|APPENDING)\s+(?:CORRESPONDING\s+FIELDS\s+OF\s+)?(?:TABLE\s+)?@?[^\s(),]+\s+FROM\s+([^\s(@]+)/);
  return m && isDdicCandidate(m[1]) ? m[1] : '';
}

/** Fields compared with = / EQ in the top-level AND conditions of the WHERE (alias~field → FIELD) */
function equalityFields(u) {
  const m = u.match(/\bWHERE\b([\s\S]*)$/);
  if (!m) return new Set();
  const w = m[1]
    .replace(/\b(?:INTO|APPENDING|ORDER\s+BY|GROUP\s+BY|HAVING|FIELDS|UP\s+TO|BYPASSING|CONNECTION)\b[\s\S]*$/, '')
    .replace(/'(?:[^']|'')*'|`(?:[^`]|``)*`/g, "''");
  const out = new Set();
  for (const part of w.split(/\bAND\b/)) {
    const c = part.trim().replace(/^\(+/, '');
    const f = c.match(/^([\w\/]+~)?([\w\/]+)\s*(?:=|EQ\b)/);
    if (f) out.add(f[2]);
    const r = c.match(/(?:=|EQ\b)\s*([\w\/]+~)?([A-Z_\/][\w\/]*)$/);
    // dbtab~field on the right side (… = @lv AND @lv = dbtab~field is rare): only an aliased field counts
    if (r && r[1]) out.add(r[2]);
  }
  return out;
}

/**
 * Key fields of the table of a SELECT SINGLE that the WHERE does not give with =, or null when that cannot be decided
 * (no DDIC information, not a single table, key include).
 */
function missingKeyFields(u, ddic) {
  if (!ddic) return null;
  if (/^SELECT\s+SINGLE\b/.test(u) && /\bJOIN\b/.test(u)) return missingJoinKeyFields(u, ddic);
  const table = selectSingleTable(u);
  if (!table) return null;
  const info = ddic.get(table);
  if (!info || info.category !== 'table' || !info.keysComplete) return null;
  const given = equalityFields(u);
  return info.keys.filter((k) => k !== info.clientKey && !given.has(k));
}

/** Tables of a FROM … JOIN clause: [{ table, alias }] (alias = table name without AS) */
function joinTables(u) {
  const out = [];
  const re = /\b(?:FROM|JOIN)\s+([A-Z_\/][\w\/]*)(?:\s+AS\s+([A-Z_][\w]*))?/g;
  let m;
  while ((m = re.exec(u)) !== null) if (isDdicCandidate(m[1])) out.push({ table: m[1], alias: m[2] || m[1] });
  return out;
}

/**
 * SELECT SINGLE with JOIN: the key fields (as alias~FIELD) that are not determined, or null when undecidable.
 * A key field is determined by = with a value (host variable, literal) in ON / WHERE, or by = with a field of a table whose
 * key is already determined. A bare name (no alias~) may be any table's field, so a key field of that name counts as given.
 * Without the DDIC keys of every table it is undecidable.
 */
function missingJoinKeyFields(u, ddic) {
  const tables = joinTables(u);
  if (tables.length < 2) return null;
  const infos = new Map();
  for (const t of tables) {
    const info = ddic.get(t.table);
    if (!info || info.category !== 'table' || !info.keysComplete) return null;
    infos.set(t.alias, info);
  }
  const cond = u
    .replace(/\b(?:INTO|APPENDING|ORDER\s+BY|GROUP\s+BY|HAVING|FIELDS|UP\s+TO|BYPASSING|CONNECTION)\b[\s\S]*?(?=\bFROM\b|\bWHERE\b|$)/g, ' ')
    .replace(/'(?:[^']|'')*'|`(?:[^`]|``)*`/g, "''");
  const parts = [];
  for (const seg of cond.split(/\bON\b|\bWHERE\b/).slice(1)) {
    const clean = seg.replace(/\b(?:(?:INNER|LEFT|RIGHT)\s+(?:OUTER\s+)?)?JOIN\b[\s\S]*$/, '');
    for (const p of clean.split(/\bAND\b/)) parts.push(p.trim().replace(/^\(+|\)+$/g, ''));
  }
  const operand = (x) => {
    const f = x.match(/^([A-Z_][\w]*)~([A-Z_\/][\w\/]*)$/);
    if (f) return infos.has(f[1]) ? { alias: f[1], field: f[2] } : { value: true };
    return /^[A-Z_\/][\w\/]*$/.test(x) && !/^SY-|^SPACE$/.test(x) ? { bare: x } : { value: true };
  };
  const eqs = [];
  const bare = new Set();
  for (const p of parts) {
    const m = p.match(/^(\S+)\s*(?:=|EQ)\s*(\S+)$/);
    if (!m) continue;
    const l = operand(m[1].replace(/^@/, ''));
    const r = operand(m[2].replace(/^@/, ''));
    if (l.bare) bare.add(l.bare);
    eqs.push([l, r]);
  }
  const bound = new Map([...infos.keys()].map((a) => [a, new Set()]));
  const determined = (a) => infos.get(a).keys.every((k) => k === infos.get(a).clientKey || bound.get(a).has(k) || bare.has(k));
  // A bare name compared with alias~field is a host variable (classic syntax without @)
  const known = (o) => o.value || o.bare || (o.alias && determined(o.alias));
  for (let changed = true; changed;) {
    changed = false;
    for (const [l, r] of eqs) {
      for (const [x, y] of [[l, r], [r, l]]) {
        if (x.alias && !bound.get(x.alias).has(x.field) && known(y)) {
          bound.get(x.alias).add(x.field);
          changed = true;
        }
      }
    }
  }
  const missing = [];
  for (const [a, info] of infos) {
    for (const k of info.keys) if (k !== info.clientKey && !bound.get(a).has(k) && !bare.has(k)) missing.push(a + '~' + k);
  }
  return missing;
}

module.exports = {
  parseTabl,
  parseTtyp,
  viewOf,
  ddicRequests,
  selectStarTable,
  equalityFields,
  missingKeyFields,
};
