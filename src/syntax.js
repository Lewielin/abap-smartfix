'use strict';

/**
 * Statement classification: decide which kind of ABAP syntax a (normalized, uppercase) statement is.
 *
 * Most false positives come from keyword matches that are too broad, for example /^SELECT\b/ matches
 * SELECT-OPTIONS / SELECTION-SCREEN (\b treats - as a word boundary), and
 * /^MODIFY\b/ matches MODIFY SCREEN and internal table operations. These distinctions live here.
 */

/** Open SQL SELECT (excluding SELECT-OPTIONS and SELECTION-SCREEN) */
function isSqlSelect(u) {
  return /^SELECT(?:\s|\(|$)/.test(u);
}

/** Reads from an internal table (SELECT ... FROM @itab), not the database */
function selectsFromItab(u) {
  return /\bFROM\s+@/.test(u);
}

/** Database SELECT (excluding SELECT-OPTIONS / SELECTION-SCREEN and SELECT … FROM @itab) */
function isDbSelect(u) {
  return isSqlSelect(u) && !selectsFromItab(u);
}

/** A name as a literal part of a regular expression (ABAP names can contain / and other special characters) */
function escapeRe(name) {
  return name.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/** Result is written to an internal table (INTO / APPENDING [CORRESPONDING FIELDS OF] TABLE) */
const RE_INTO_TABLE = /\b(?:INTO|APPENDING)\s+(?:CORRESPONDING\s+FIELDS\s+OF\s+)?TABLE\s+(\S+)/;

function intoTableTarget(u) {
  const m = u.match(RE_INTO_TABLE);
  return m ? baseName(m[1]) : '';
}

/** Extract the SELECT field list (classic: between SELECT and FROM; new syntax: after FIELDS) */
function selectFieldList(u) {
  const f = u.match(/\bFIELDS\s+([\s\S]*?)(?=\s+(?:WHERE|INTO|APPENDING|GROUP|HAVING|ORDER|UNION|FOR\s+ALL)\b|$)/);
  if (f) return f[1];
  const m = u.match(/^SELECT\s+(?:SINGLE\s+)?(?:FOR\s+UPDATE\s+)?(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\b/);
  return m ? m[1] : '';
}

/** Field list has only aggregate functions and no GROUP BY: a single row result, not a loop */
function isAggregateOnly(u) {
  if (/\bGROUP\s+BY\b/.test(u)) return false;
  const list = selectFieldList(u).trim();
  if (!list) return false;
  return /^(?:(?:COUNT|SUM|MIN|MAX|AVG)\s*\([^()]*\)(?:\s+AS\s+\S+)?\s*,?\s*)+$/.test(list);
}

/**
 * May be a SELECT ... ENDSELECT loop: no SINGLE, not only aggregates,
 * not written to an internal table (or written to one with PACKAGE SIZE).
 * The final decision is whether a matching ENDSELECT exists (see analyzer.buildSelectLoops).
 */
function isSelectLoopCandidate(u) {
  if (!isSqlSelect(u) || /^SELECT\s+SINGLE\b/.test(u)) return false;
  if (isAggregateOnly(u)) return false;
  if (RE_INTO_TABLE.test(u)) return /\bPACKAGE\s+SIZE\b/.test(u);
  return true;
}

/** Program unit boundaries: loops and SELECT loops never span these statements */
function isUnitBoundary(u) {
  return /^(?:END)?(?:FORM|METHOD|FUNCTION|MODULE)(?:\s|$)/.test(u) ||
    /^(?:START-OF-SELECTION|END-OF-SELECTION|INITIALIZATION|AT\s+SELECTION-SCREEN|TOP-OF-PAGE|END-OF-PAGE|LOAD-OF-PROGRAM|AT\s+LINE-SELECTION|AT\s+USER-COMMAND)\b/.test(u);
}

/** Strip @, DATA( ), [] and similar decorations and return the data object name (lowercase) */
function baseName(tok) {
  let t = String(tok || '').trim();
  const inl = t.match(/^@?(?:DATA|FINAL|FIELD-SYMBOL)\(\s*([^)\s]+)\s*\)/i);
  if (inl) t = inl[1];
  t = t.replace(/^@/, '').replace(/\[\]$/, '').replace(/[,.]$/, '');
  return t.toLowerCase();
}

/**
 * Common internal table / local variable prefixes (lt_, gt_, it_, ls_, mt_ …), or structure components,
 * object attributes and field symbols: never a database table.
 */
function looksLikeDataObject(name) {
  const n = String(name || '').toLowerCase();
  if (/[-~<>\[]|->|=>/.test(n)) return true;
  return /^(?:[lgmsp][tsrv]|[iecr]t|[xy]t|t|ls|lr|lo|go|mo)_/.test(n);
}

/**
 * Whether INSERT / UPDATE / MODIFY / DELETE is a database operation.
 * Internal table operations (INSERT … INTO TABLE, MODIFY TABLE, DELETE ADJACENT, MODIFY SCREEN …)
 * are not covered by the Code Inspector "SY-SUBRC handling" check.
 *
 * @param {string} u statement text in uppercase
 * @param {Set<string>} localNames data objects declared in this file (lowercase)
 */
function isDbModification(u, localNames) {
  const known = (n) => {
    const b = baseName(n);
    return !b || looksLikeDataObject(b) || (localNames && localNames.has(b));
  };
  const dynamic = (n) => /^\(/.test(n);

  // Internal tables have no UPDATE; FROM TABLE and INSERT INTO … VALUES only exist for database tables
  if (/^UPDATE\s/.test(u)) return true;
  if (/\bFROM\s+TABLE\b/.test(u) && /^(?:INSERT|MODIFY|DELETE)\s/.test(u)) return true;

  if (/^INSERT\s/.test(u)) {
    if (/^INSERT\s+(?:REPORT|TEXTPOOL|DYNPRO|LINES\s+OF|INITIAL\s+LINE)\b/.test(u)) return false;
    if (/^INSERT\s+INTO\s+\S+\s+VALUES\b/.test(u)) return true;
    // INSERT wa INTO [TABLE] itab [INDEX n] is always an internal table
    if (/\bINTO\b/.test(u)) return false;
    const m = u.match(/^INSERT\s+(\S+)(\s+FROM\b)?/);
    return !!m && (dynamic(m[1]) || !!m[2] || !known(m[1]));
  }

  if (/^MODIFY\s/.test(u)) {
    if (/^MODIFY\s+(?:TABLE|SCREEN|LINE|CURRENT\s+LINE)\b/.test(u)) return false;
    if (/\b(?:INDEX|TRANSPORTING|USING\s+KEY)\b/.test(u)) return false;
    // MODIFY itab FROM wa (inside LOOP) looks the same as MODIFY dbtab FROM wa; only the name tells them apart
    const m = u.match(/^MODIFY\s+(\S+)/);
    return !!m && (dynamic(m[1]) || !known(m[1]));
  }

  if (/^DELETE\s/.test(u)) {
    if (/^DELETE\s+(?:TABLE|ADJACENT|DATASET|REPORT|TEXTPOOL|DYNPRO)\b/.test(u)) return false;
    let m = u.match(/^DELETE\s+FROM\s+(\S+)/);
    if (m) return !/^(?:MEMORY|SHARED|DATABASE)$/.test(m[1]);
    // DELETE itab WHERE … / INDEX n / FROM n TO m is an internal table
    if (/\b(?:INDEX|WHERE|USING\s+KEY|TO)\b/.test(u)) return false;
    m = u.match(/^DELETE\s+(\S+)(?:\s+FROM\s+(\S+))?/);
    if (!m) return false;
    if (dynamic(m[1])) return true;
    if (known(m[1]) || (m[2] && /^\d+$/.test(m[2]))) return false;
    return true;
  }

  return false;
}

/**
 * Whether the WHERE of a SELECT SINGLE is "certainly" not a full primary key given with =.
 * Without DDIC information the primary key is unknown, so only visible cases are reported:
 * no WHERE, OR / NOT / range comparisons / IN / LIKE / BETWEEN / IS NULL, or a dynamic condition.
 */
function selectSingleNotFullKey(u) {
  const m = u.match(/\bWHERE\b([\s\S]*)$/);
  if (!m) return true;
  let w = m[1]
    .replace(/\b(?:INTO|APPENDING|ORDER\s+BY|GROUP\s+BY|HAVING)\b[\s\S]*$/, '')
    .replace(/'(?:[^']|'')*'|`(?:[^`]|``)*`/g, "''")
    .replace(/->|=>/g, '~')
    .replace(/<[\w\/]+>/g, 'fs');
  if (/^\s*\(\s*@?[A-Z_\/][\w\/\-~]*\s*\)\s*$/.test(w)) return true;
  return /\b(?:OR|NOT|IN|LIKE|BETWEEN|NE|LT|GT|LE|GE|NULL|INITIAL)\b|<>|<|>/.test(w);
}

/**
 * Extract all text literals of a statement: '…', `…`, and the text outside { } in string templates |…|.
 * 'text'(001) is linked to a text symbol, so textSymbol is true.
 * @param {string} text original statement text (normalized by the lexer, literal content unchanged)
 * @returns {Array<{value: string, textSymbol: boolean}>}
 */
function textLiterals(text) {
  const out = [];
  const t = String(text || '');
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === "'" || ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < t.length) {
        if (t[j] === ch) {
          if (t[j + 1] === ch) { value += ch; j += 2; continue; }
          break;
        }
        value += t[j++];
      }
      i = j + 1;
      const textSymbol = ch === "'" && /^\(\s*[A-Za-z0-9_]{1,3}\s*\)/.test(t.slice(i));
      out.push({ value, textSymbol });
      continue;
    }
    if (ch === '|') {
      // Inside a template, { } holds an expression (may be nested); only the text outside is collected
      let j = i + 1;
      let value = '';
      let depth = 0;
      while (j < t.length) {
        const c = t[j];
        if (depth === 0 && c === '\\') { value += t[j + 1] || ''; j += 2; continue; }
        if (depth === 0 && c === '|') break;
        if (c === '{') { depth++; value += ' '; } else if (c === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0) value += c;
        j++;
      }
      i = j + 1;
      out.push({ value, textSymbol: false });
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Literals reported by the extended program check "text without text symbol" (##NO_TEXT):
 * containing letters or CJK characters, at least 2 characters long, not looking like a technical name
 * (all-uppercase MATNR, ERDAT, 'EQ' …), and not linked to a text symbol.
 */
function isTranslatableText(lit) {
  if (lit.textSymbol) return false;
  const v = lit.value.trim();
  // One CJK character is already a word ('\u8A3B'); one Latin letter is not ('X')
  const cjk = /[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(v);
  if (v.length < 2 && !cjk) return false;
  if (!cjk && !/[A-Za-z]/.test(v)) return false;
  if (/^[A-Z0-9_\/\-=>~*%&$#.:]+$/.test(v)) return false;
  return true;
}

module.exports = {
  textLiterals,
  isTranslatableText,
  isSqlSelect,
  selectsFromItab,
  isDbSelect,
  escapeRe,
  intoTableTarget,
  isSelectLoopCandidate,
  isUnitBoundary,
  baseName,
  isDbModification,
  selectSingleNotFullKey,
};
