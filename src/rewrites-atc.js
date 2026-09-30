'use strict';

/**
 * Rewrites for syntax check warnings that no annotation can suppress, used by the rules client-specified-obsolete and
 * language-literal (rules.js): fix on the statements the source check finds, atcFix on the ones ATC reports (atc.js):
 *
 *   MESSAGE GGC  Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED"
 *                SELECT … FROM t CLIENT SPECIFIED … WHERE mandt = x AND …  →  SELECT … FROM t USING CLIENT @x … WHERE …
 *                without a single client condition                         →  SELECT … FROM t USING ALL CLIENTS …
 *                USING CLIENT puts the statement into strict mode, so the same rewrite writes the lists comma-separated
 *                and escapes host variables with @ (a dynamic column list assigned from a literal gets commas too).
 *   MESSAGE GXD  The type of "'EN'" cannot be converted to the type of "SPRSL" (a language key is one character)
 *                spras = 'EN'  →  spras = 'E'  (the value ABAP already truncates 'EN' to at runtime)
 *
 * Same contract as rewrites.js: { safety, summary, edits } or null when the statement is not a form handled here.
 */

const { ORDER, ins, sliceWords } = require('./rewrites');
const { escapeRe } = require('./syntax');

const isLiteral = (t) => /^['`]/.test(t) || /^[-+]?\d+$/.test(t);

/** Parenthesis depth change of a word (literals do not count) */
function depthDelta(t) {
  if (/^['`]/.test(t)) return 0;
  return (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
}

/** Start index of each top-level clause of a SELECT (SELECT, FROM, CLIENT, INTO, FOR, WHERE, GROUP, HAVING, ORDER, UP, PACKAGE) */
function selectClauses(words) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < words.length; i++) {
    const u = words[i].upper;
    if (depth === 0) {
      const next = words[i + 1] ? words[i + 1].upper : '';
      if (i === 0 && u === 'SELECT') out.push({ name: 'SELECT', i });
      else if (u === 'FROM' || u === 'WHERE' || u === 'HAVING') out.push({ name: u, i });
      else if (u === 'CLIENT' && next === 'SPECIFIED') out.push({ name: 'CLIENT', i });
      else if (u === 'INTO' || u === 'APPENDING') out.push({ name: 'INTO', i });
      else if (u === 'FOR' && next === 'ALL') out.push({ name: 'FOR', i });
      else if ((u === 'GROUP' || u === 'ORDER') && next === 'BY') out.push({ name: u, i });
      else if (u === 'UP' && next === 'TO') out.push({ name: 'UP', i });
      else if (u === 'PACKAGE' && next === 'SIZE') out.push({ name: 'PACKAGE', i });
    }
    depth += depthDelta(words[i].text);
  }
  return depth === 0 ? out : null;
}

/** Word range [from, to) of a clause, or null */
function clauseRange(clauses, name, total) {
  const k = clauses.findIndex((c) => c.name === name);
  if (k < 0) return null;
  return { from: clauses[k].i, to: k + 1 < clauses.length ? clauses[k + 1].i : total };
}

/**
 * Elements of a list (select list, GROUP BY, ORDER BY): a word, or a function call spanning words (MAX( x )),
 * followed by AS alias / ASCENDING / DESCENDING. Returns the index of each element's last word, or null for lists that are
 * already comma-separated or not simple.
 */
function listElementEnds(words, from, to) {
  const ends = [];
  let i = from;
  while (i < to) {
    const t = words[i].text;
    if (/,$/.test(t)) return null;
    // A function call such as MAX( modda ) spans words until its closing parenthesis
    let depth = depthDelta(t);
    while (depth > 0 && i + 1 < to) {
      i++;
      depth += depthDelta(words[i].text);
    }
    if (depth !== 0) return null;
    if (i + 2 < to && words[i + 1].upper === 'AS') i += 2;
    else if (i + 1 < to && /^(?:ASCENDING|DESCENDING)$/.test(words[i + 1].upper)) i += 1;
    ends.push(i);
    i++;
  }
  return ends;
}

/** Commas after every element but the last */
function commaEdits(words, from, to) {
  if (to - from < 2) return [];
  const ends = listElementEnds(words, from, to);
  if (!ends) return null;
  return ends.slice(0, -1).map((e) => ins(words[e].line, words[e].endCol, ','));
}

/**
 * Whether an operand word is a host variable, which strict mode writes with @: a component (ls-a, sy-mandt, itab-f),
 * a field symbol, or a data object declared in this file. A literal, an escaped operand or a column (a~b) is not;
 * an undeclared plain name may be a column, so it is unknown (null).
 */
function isHost(text, ctx) {
  if (isLiteral(text) || /^@/.test(text) || /~/.test(text)) return false;
  if (/^<[\w\/]+>/.test(text) || /^[A-Za-z_\/][\w\/]*(?:-|->|=>)/.test(text)) return true;
  if (/^[A-Za-z_\/][\w\/]*$/.test(text)) {
    if (BUILTIN_HOSTS.test(text.toUpperCase())) return true;
    if (ctx.localNames && ctx.localNames.has(text.toLowerCase())) return true;
    // Declared in another include: with the table's columns from the DDIC, a name that is no column is a data object
    if (ctx.columns) return !ctx.columns.has(text.toUpperCase());
    return null;
  }
  return null;
}

// Data objects every program has (SPACE, the constants of type pool ABAP)
const BUILTIN_HOSTS = /^(?:SPACE|ABAP_TRUE|ABAP_FALSE|ABAP_UNDEFINED|ABAP_ON|ABAP_OFF|ABAP_ON_INV)$/;

/** Reason for a name that may be a column or a data object declared elsewhere */
function undeclared(name) {
  return name + ' is not declared in this file and may be a column (declared in an include?); with ADT logged on, the ' +
    'table columns decide it';
}

/**
 * @ for each data object of an INTO list: (a, b) / ( a , b ) → (@a, @b). The targets of INTO are always data objects.
 * Returns the edits, or null when the list is not a simple list of names.
 */
function intoListEdits(w, from, to) {
  const edits = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = w[i].text;
    const m = t.match(/^(\(?)([^(),]*)(\)?,?|,?\)?)$/);
    if (!m) return null;
    if (m[1]) depth++;
    const name = m[2];
    if (name && name !== ',') {
      if (!/^(?:<[\w\/]+>|[A-Za-z_\/][\w\/]*)(?:(?:-|->)[\w\/]+)*$/.test(name) && !/^@/.test(name)) return null;
      if (!/^@/.test(name)) edits.push(ins(w[i].line, w[i].col + m[1].length, '@'));
    }
    if (/\)/.test(m[3])) depth--;
  }
  return depth === 0 && edits.length ? edits : null;
}

/**
 * @ escapes for the operands of a condition (WHERE / HAVING): the word after a comparison operator, the second
 * bound of BETWEEN, a selection table after IN. Returns the word indexes to escape, or { why } when an operand is not
 * known to be a host variable or a column.
 */
function conditionHosts(words, from, to, ctx) {
  const out = [];
  let expectOperand = false;
  let inList = 0;
  for (let i = from + 1; i < to; i++) {
    const t = words[i].text;
    const u = words[i].upper;
    if (inList) {
      if (t === ')') { inList--; continue; }
      const op = t.replace(/,$/, '');
      if (!op) continue;
      const host = isHost(op, ctx);
      if (host === null) return { why: undeclared(op) };
      if (host) out.push(i);
      continue;
    }
    if (/^(?:=|<>|<|>|<=|>=|EQ|NE|LT|GT|LE|GE|LIKE)$/.test(u)) { expectOperand = true; continue; }
    if (u === 'IN') {
      if (words[i + 1] && words[i + 1].text === '(') { inList = 1; i++; continue; }
      expectOperand = true;
      continue;
    }
    if (u === 'BETWEEN') { expectOperand = true; continue; }
    if (expectOperand) {
      expectOperand = false;
      // A word glued to a parenthesis or an expression: not a form handled here
      if (/[()]/.test(t) && !/^['`]/.test(t)) return { why: 'the operand ' + t + ' is an expression' };
      const host = isHost(t, ctx);
      if (host === null) return { why: undeclared(t) };
      if (host) out.push(i);
      // BETWEEN a AND b: the operand after AND is the second bound
      if (words[i + 1] && words[i + 1].upper === 'AND' && words[i - 1] && words[i - 1].upper === 'BETWEEN') { expectOperand = true; i++; }
      continue;
    }
    // Columns, AND / OR / NOT, IS [NOT] NULL / INITIAL, parentheses: nothing to escape
  }
  return out;
}

const CLIENT_COLUMN = /^(?:[\w\/]+~)?(?:MANDT|CLIENT|MANDANT)$/;

/**
 * The top-level "client column = value" condition of the WHERE, when USING CLIENT can take it over: the WHERE has no
 * top-level OR and the value is a literal or a host variable that is not a FOR ALL ENTRIES component. Returns the words to
 * delete ([from, to] positions) and the value, or null.
 */
function clientCondition(words, where, faeTable, ctx) {
  if (!where) return null;
  let depth = 0;
  for (let i = where.from + 1; i < where.to; i++) {
    if (depth === 0 && words[i].upper === 'OR') return null;
    depth += depthDelta(words[i].text);
  }
  depth = 0;
  for (let i = where.from + 1; i < where.to; i++) {
    const top = depth === 0;
    depth += depthDelta(words[i].text);
    if (!top || !CLIENT_COLUMN.test(words[i].upper)) continue;
    if (!words[i + 1] || !/^(?:=|EQ)$/.test(words[i + 1].upper) || i + 2 >= where.to) return null;
    const value = words[i + 2];
    if (faeTable && value.upper.replace(/^@/, '').indexOf(faeTable + '-') === 0) return null;
    const prev = words[i - 1];
    const next = words[i + 3];
    let range;
    if (prev.upper === 'AND') range = { line: words[i - 2].line, col: words[i - 2].endCol, endLine: value.line, endCol: value.endCol };
    else if (prev.upper === 'WHERE' && next && i + 3 < where.to && next.upper === 'AND' && words[i + 4]) {
      range = { line: words[i].line, col: words[i].col, endLine: words[i + 4].line, endCol: words[i + 4].col };
    } else if (prev.upper === 'WHERE' && i + 3 >= where.to) {
      // The only condition: the whole WHERE goes
      range = { line: prev.line, col: prev.col, endLine: value.line, endCol: value.endCol };
    } else return null;
    // Only a deletion inside one line that leaves code on it: the fixer places pseudo comments on the statement's lines
    if (range.line !== range.endLine) return null;
    const text = ctx.lines[range.line] || '';
    const cm = ctx.comments[range.line];
    const codeEnd = cm && !cm.fullLine ? cm.col : text.length;
    if (!/\S/.test(text.slice(0, range.col) + text.slice(range.endCol, codeEnd))) return null;
    return { range, value, first: i, last: i + 2 };
  }
  return null;
}

/**
 * The literal assignments of a dynamic column list (lv_cols = 'A B C'.), rewritten comma-separated for strict mode.
 * Returns the edits, [] when they are comma-separated already, or null when the variable is filled another way.
 */
function dynamicListEdits(name, ctx) {
  const esc = escapeRe(name);
  const any = new RegExp('(?:^|[^\\w\\/-])' + esc + '(?![\\w\\/])', 'i');
  const assign = new RegExp('^' + esc + '\\s*=\\s*([\'`])', 'i');
  const declared = new RegExp('^(?:DATA|STATICS|CLASS-DATA|CONSTANTS)\\s+' + esc + '(?![\\w\\/])', 'i');
  const concat = new RegExp('^CONCATENATE\\s[\\s\\S]*\\sINTO\\s+' + esc + '\\s+SEPARATED\\s+BY\\s+(?:SPACE|\' \'|` `)$', 'i');
  const literals = (st) => st.words.filter((w) => /^['`]/.test(w.text));
  const closed = (w) => w.text.length > 1 && w.text.charAt(w.text.length - 1) === w.text.charAt(0);
  const edits = [];
  let assigned = 0;
  // Only plain column names: then the comma-separated form is certain
  let plain = true;
  const column = (c) => /^[A-Za-z0-9_\/~]+$/.test(c) && !/^(?:AS|DISTINCT|SINGLE)$/i.test(c);
  // 'A B C' → 'A, B, C'
  const listLiteral = (lit) => {
    const q = lit.text.charAt(0);
    const inner = lit.text.slice(1, -1);
    if (!inner.trim().split(/[\s,]+/).filter(Boolean).every(column)) plain = false;
    if (/,/.test(inner) || !/\S\s+\S/.test(inner)) return;
    edits.push({ line: lit.line, col: lit.col, endLine: lit.line, endCol: lit.endCol, text: q + inner.trim().split(/\s+/).join(', ') + q, order: ORDER.inline });
  };
  for (const st of ctx.statements) {
    if (!any.test(st.upper)) continue;
    // Used as a dynamic token of a SELECT / OPEN CURSOR: fine
    if (new RegExp('\\(\\s*' + esc + '\\s*\\)', 'i').test(st.upper) && /^(?:SELECT|OPEN\s+CURSOR)\b/.test(st.upper)) continue;
    if (declared.test(st.upper)) {
      // DATA cols TYPE string VALUE 'A B C': the start value is an assignment too
      const lits = literals(st);
      const v = st.words.findIndex((w) => w.upper === 'VALUE');
      if (v < 0) continue;
      if (lits.length !== 1 || st.words[v + 1] !== lits[0] || !closed(lits[0])) return null;
      assigned++;
      listLiteral(lits[0]);
      continue;
    }
    if (concat.test(st.upper)) {
      // CONCATENATE 'A' 'B' INTO cols SEPARATED BY space: each part one column, the separator becomes `, `
      const into = st.words.findIndex((w) => w.upper === 'INTO');
      const parts = st.words.slice(1, into);
      if (!parts.length || parts.some((w) => !/^['`]/.test(w.text) || !closed(w) || /\s/.test(w.text.slice(1, -1).trim()))) return null;
      const sep = st.words[st.words.length - 1];
      if (!parts.every((w) => column(w.text.slice(1, -1).trim()))) plain = false;
      assigned++;
      edits.push({ line: sep.line, col: sep.col, endLine: sep.line, endCol: sep.endCol, text: '`, `', order: ORDER.inline });
      continue;
    }
    if (!assign.test(st.upper)) return null;
    const lits = literals(st);
    if (lits.length !== 1 || !closed(lits[0])) return null;
    assigned++;
    listLiteral(lits[0]);
  }
  // An alias, a function or DISTINCT cannot be split at the blanks: left for a manual fix
  return assigned && plain ? edits : null;
}

/** The letter case of the source: keywords written lowercase stay lowercase */
function caseLike(sample, text) {
  return /[a-z]/.test(sample) && !/[A-Z]/.test(sample) ? text.toLowerCase() : text;
}

/**
 * SELECT … CLIENT SPECIFIED … → USING CLIENT @x (the client condition moves out of the WHERE) or USING ALL CLIENTS
 * (no single client condition: the conditions on the client column stay in the WHERE), with the lists comma-separated and
 * host variables escaped as strict mode requires. Joins, UNION, subqueries and chained statements are left for a manual fix.
 */
function clientSpecifiedToUsingClient(s, ctx) {
  return usingClient(s, ctx, () => null);
}

/** Why CLIENT SPECIFIED of statement s cannot be rewritten to USING CLIENT here, or '' when it can */
function usingClientBlocker(s, ctx) {
  let why = '';
  const r = usingClient(s, ctx, (reason) => { why = reason; return null; });
  return r ? '' : why || 'not a form handled here';
}

function usingClient(s, stmtCtx, no) {
  if (s.chained) return no('chained statement (DATA: … style); write it as a single statement');
  if (!s.terminator) return no('no period at the end of the statement');
  if (!/^SELECT(?:\s|\()/.test(s.upper)) return no('not a SELECT');
  const w = s.words;
  const bad = w.find((x) => /^(?:JOIN|UNION|WITH|FIELDS|EXISTS|BYPASSING|CONNECTION|INTERSECT|EXCEPT)$/.test(x.upper));
  if (bad) return no(bad.upper + ' in the statement');
  // A subquery: a second SELECT
  if (w.slice(1).some((x) => /^\(?SELECT$/.test(x.upper))) return no('a subquery');
  const clauses = selectClauses(w);
  if (!clauses) return no('unbalanced parentheses');
  const range = (name) => clauseRange(clauses, name, w.length);
  const client = range('CLIENT');
  const from = range('FROM');
  if (!client || !from || w[client.from].line !== w[client.from + 1].line || client.to !== client.from + 2) {
    return no('CLIENT SPECIFIED is split over two lines or not after the table');
  }
  if (from.to - from.from < 2) return no('no table after FROM');
  // The columns of the table (DDIC), to tell a column from a data object declared in another include
  const info = stmtCtx.ddic && stmtCtx.ddic.get ? stmtCtx.ddic.get(w[from.from + 1].upper) : null;
  const ctx = info && info.fields && info.fields.length && !info.hasIncludes
    ? Object.assign({}, stmtCtx, { columns: new Set(info.fields) }) : stmtCtx;

  const edits = [];
  const escape = new Set();

  // Select list
  const sel = range('SELECT');
  let listFrom = sel.from + 1;
  while (listFrom < sel.to && /^(?:SINGLE|DISTINCT)$/.test(w[listFrom].upper)) listFrom++;
  const dyn = sel.to - listFrom === 1 && w[listFrom].text.match(/^\(\s*([A-Za-z_\/][\w\/\-]*)\s*\)$/);
  let dynamicList = false;
  if (dyn) {
    const le = dynamicListEdits(dyn[1], ctx);
    if (!le) return no('the dynamic column list (' + dyn[1] + ') is filled another way than a literal, DATA … VALUE or CONCATENATE … SEPARATED BY space, or holds more than column names (it must become comma-separated for strict mode)');
    edits.push(...le);
    dynamicList = le.length > 0;
  } else if (!(sel.to - listFrom === 1 && w[listFrom].text === '*')) {
    const ce = commaEdits(w, listFrom, sel.to);
    if (!ce) return no('the column list is not a simple list');
    edits.push(...ce);
  }

  // INTO / APPENDING [CORRESPONDING FIELDS OF] [TABLE] target, or a list INTO (a, b): every target is a data object
  const into = range('INTO');
  if (into) {
    let t = into.from + 1;
    while (t < into.to && /^(?:CORRESPONDING|FIELDS|OF|TABLE)$/.test(w[t].upper)) t++;
    if (t >= into.to) return no('INTO without a target');
    if (/^\(/.test(w[t].text) && !/^(?:DATA|FINAL)\(/i.test(w[t].text)) {
      const le = intoListEdits(w, t, into.to);
      if (!le) return no('the INTO list is not a simple list of data objects');
      edits.push(...le);
    } else {
      if (t !== into.to - 1) return no('INTO with more than one word after the target (' + w[t + 1].text + ')');
      if (!/^(?:@|DATA\(|FINAL\()/.test(w[t].upper)) {
        if (/[()]/.test(w[t].text)) return no('INTO target ' + w[t].text + ' is an expression');
        escape.add(t);
      }
    }
  }

  // FOR ALL ENTRIES IN itab
  const fae = range('FOR');
  let faeTable = '';
  if (fae) {
    const t = fae.from + 4;
    if (t !== fae.to - 1) return no('FOR ALL ENTRIES IN is not followed by a single table');
    faeTable = w[t].upper.replace(/^@/, '');
    if (!/^@/.test(w[t].text)) escape.add(t);
  }

  // USING CLIENT @x when the WHERE has a single client condition, otherwise USING ALL CLIENTS
  const where = range('WHERE');
  const cond = clientCondition(w, where, faeTable, ctx);
  let using;
  if (cond) {
    const v = cond.value.text.replace(/^@/, '');
    const host = isHost(v, ctx);
    if (host === null) return no(undeclared(v));
    using = caseLike(w[client.from].text, 'USING CLIENT ') + (host ? '@' : '') + v;
    edits.push(Object.assign({ text: '', order: ORDER.inline }, cond.range));
  } else {
    using = caseLike(w[client.from].text, 'USING ALL CLIENTS');
  }
  edits.push({
    line: w[client.from].line, col: w[client.from].col, endLine: w[client.from + 1].line, endCol: w[client.from + 1].endCol,
    text: using, order: ORDER.inline,
  });

  for (const name of ['WHERE', 'HAVING']) {
    const r = range(name);
    if (!r) continue;
    const hosts = conditionHosts(w, r.from, r.to, ctx);
    if (!Array.isArray(hosts)) return no(hosts.why);
    for (const i of hosts) if (!cond || i < cond.first || i > cond.last) escape.add(i);
  }

  for (const name of ['GROUP', 'ORDER']) {
    const r = range(name);
    if (!r) continue;
    if (name === 'ORDER' && w[r.from + 2] && w[r.from + 2].upper === 'PRIMARY') continue;
    const ce = commaEdits(w, r.from + 2, r.to);
    if (!ce) return no(name + ' BY is not a simple list');
    edits.push(...ce);
  }

  for (const name of ['UP', 'PACKAGE']) {
    const r = range(name);
    if (!r) continue;
    const n = r.from + 2;
    if (!w[n]) return no(name + ' without a number');
    const host = isHost(w[n].text, ctx);
    if (host === null) return no(undeclared(w[n].text));
    if (host) escape.add(n);
  }

  for (const i of escape) if (!/^@/.test(w[i].text)) edits.push(ins(w[i].line, w[i].col, '@'));

  // Obsolete short form without INTO (SELECT SINGLE * FROM dbtab … with TABLES dbtab): strict mode needs INTO @dbtab
  if (!into) {
    const table = w[from.from + 1];
    const declared = sel.to - listFrom === 1 && w[listFrom].text === '*' &&
      ctx.statements.some((x) => x.words.length === 2 && x.words[0].upper === 'TABLES' && x.words[1].upper === table.upper);
    if (!declared) return no('no INTO and no TABLES ' + table.upper + ' work area');
    const up = range('UP');
    const at = up ? w[up.from - 1] : w[w.length - 1];
    edits.push(ins(at.line, at.endCol, caseLike(w[0].text, ' INTO') + ' @' + table.text));
  }

  // Strict mode wants INTO / APPENDING after WHERE, GROUP BY, HAVING and ORDER BY (only UP TO may follow it)
  const moved = clauseOrderEdits(s, w, clauses, edits, ctx);
  if (moved === null) return no('a comment or line layout inside the statement that the clauses cannot be reordered around');

  const target = sliceWords(ctx, w, client.from, client.from + 1);
  return {
    // A dynamic column list is only rewritten when it holds column names alone, so its comma-separated form is certain
    safety: 'safe',
    summary: target.replace(/\s+/g, ' ') + ' → ' + using + ' (strict mode: comma-separated lists, @ host variables' +
      (dynamicList ? ', dynamic column list comma-separated' : '') + (moved ? ', INTO moved to the end' : '') + ')',
    edits: moved || edits,
  };
}

// Clause order of strict mode: SELECT list, FROM (with USING CLIENT), FOR ALL ENTRIES, WHERE, GROUP BY, HAVING, ORDER BY, INTO
// (with PACKAGE SIZE), UP TO
const STRICT_RANK = { SELECT: 0, FROM: 1, CLIENT: 1, FOR: 2, WHERE: 3, GROUP: 4, HAVING: 5, ORDER: 6, INTO: 7, PACKAGE: 7, UP: 8 };

/**
 * When the clauses are not in strict-mode order (INTO before FOR ALL ENTRIES / WHERE …), the statement's code is rebuilt in
 * that order: the statement's edits are applied to each piece of a clause on a line, the pieces are sorted by clause and put
 * back on the same lines with the same number of pieces per line. The line count and the end-of-line comments stay, so
 * pseudo comments, the preview and the line numbers of later findings are not affected.
 * Returns the edits replacing the code of each line, false when the order is already right, or null (not a form handled here).
 */
function clauseOrderEdits(s, w, clauses, edits, ctx) {
  const rankOf = new Array(w.length);
  for (let k = 0; k < clauses.length; k++) {
    const to = k + 1 < clauses.length ? clauses[k + 1].i : w.length;
    for (let i = clauses[k].i; i < to; i++) rankOf[i] = STRICT_RANK[clauses[k].name];
  }
  // Pieces: runs of words of the same clause on the same line
  const pieces = [];
  for (let i = 0; i < w.length; i++) {
    const p = pieces[pieces.length - 1];
    if (p && p.line === w[i].line && p.rank === rankOf[i]) p.last = i;
    else pieces.push({ line: w[i].line, rank: rankOf[i], first: i, last: i });
  }
  if (pieces.every((p, k) => !k || pieces[k - 1].rank <= p.rank)) return false;

  // Only edits inside the statement's words can be carried along with a piece
  const inside = (e, p) => e.line === p.line && e.endLine === p.line && e.col >= w[p.first].col && e.endCol <= w[p.last].endCol;
  const own = edits.filter((e) => e.line >= s.startLine && e.line <= s.endLine);
  if (own.some((e) => !pieces.some((p) => inside(e, p)))) return null;
  for (const p of pieces) {
    const line = ctx.lines[p.line] || '';
    const a = w[p.first].col;
    let text = line.slice(a, w[p.last].endCol);
    const mine = own.filter((e) => inside(e, p)).sort((x, y) => y.col - x.col || (y.order || 0) - (x.order || 0));
    for (const e of mine) text = text.slice(0, e.col - a) + e.text + text.slice(e.endCol - a);
    p.text = text.trim();
  }

  const lines = [];
  for (const p of pieces) {
    const l = lines[lines.length - 1];
    if (l && l.line === p.line) l.count++;
    else lines.push({ line: p.line, count: 1 });
  }
  const sorted = pieces.slice().sort((x, y) => x.rank - y.rank || x.first - y.first);
  const out = edits.filter((e) => own.indexOf(e) < 0);
  let k = 0;
  for (const l of lines) {
    const mine = sorted.slice(k, k + l.count);
    const firstOnLine = pieces.find((p) => p.line === l.line);
    const lastOnLine = pieces.filter((p) => p.line === l.line).pop();
    k += l.count;
    out.push({
      line: l.line, col: w[firstOnLine.first].col, endLine: l.line, endCol: w[lastOnLine.last].endCol,
      text: mine.map((p) => p.text).filter(Boolean).join(' '), order: ORDER.inline,
    });
  }
  return out;
}

// SAP language keys (LANG, one character) of the ISO codes, for a two-letter ISO code compared with a language field
const ISO_TO_SAP = {
  EN: 'E', DE: 'D', FR: 'F', IT: 'I', JA: 'J', NL: 'N', PT: 'P', RU: 'R', ES: 'S', ZH: '1', KO: '3', PL: 'L',
  CS: 'C', DA: 'K', FI: 'U', SV: 'V', TR: 'T', HU: 'H', NO: 'O',
};
const LANGUAGE_FIELD = /^(?:SPRAS|SPRSL|LANGU|LANG|DDLANGUAGE|SPRACHE|MASTERLANG|LANGUAGE|[\w\/]*_(?:SPRAS|LANGU))$/;

/**
 * spras = 'EN' → spras = 'E': ATC reports that the two-letter literal cannot be converted to the one-character language
 * field (MESSAGE GXD). At runtime ABAP truncates it to its first character; when that is the SAP key of the ISO code
 * (EN → E) the rewrite keeps the result. Otherwise (ES → S, where truncation gives E) it corrects the language (review).
 */
function languageLiteral(s, ctx, atc) {
  const m = String(atc && atc.message || '').match(/type of "(['`])([^'`]*)\1" cannot be converted to the type of "([^"]+)"/i);
  if (!m || !LANGUAGE_FIELD.test(m[3].toUpperCase())) return null;
  return languageEdits(s, (hit) => hit.lit === m[1] + m[2] + m[1], m[3]);
}

/**
 * Two-letter literals compared with a language field in the conditions of s ("spras = 'EN'"), optionally only those
 * accepted by keep. Returns the rewrite, or null.
 */
function languageEdits(s, keep, fieldName) {
  const edits = [];
  const found = [];
  s.words.forEach((x, i) => {
    const lit = x.text.match(/^(['`])([A-Za-z]{2})\1$/);
    const op = s.words[i - 1];
    const field = s.words[i - 2];
    if (!lit || !op || !field || !/^(?:=|<>|EQ|NE)$/.test(op.upper)) return;
    const name = field.upper.replace(/^[\w\/]+~/, '');
    const hit = { lit: x.text, quote: lit[1], value: lit[2], field: name };
    if (!LANGUAGE_FIELD.test(name) || (keep && !keep(hit))) return;
    const sap = ISO_TO_SAP[lit[2].toUpperCase()];
    if (!sap) return;
    edits.push({ line: x.line, col: x.col, endLine: x.line, endCol: x.endCol, text: lit[1] + sap + lit[1], order: ORDER.inline });
    found.push(Object.assign(hit, { sap }));
  });
  if (!edits.length) return null;
  const f = found[0];
  // Truncation of the two letters keeps the language (EN → E): same result; otherwise the rewrite changes it (review)
  const same = found.every((h) => h.value.charAt(0).toUpperCase() === h.sap);
  return {
    safety: same ? 'safe' : 'review',
    summary: f.lit + ' → ' + f.quote + f.sap + f.quote + ' (' + (fieldName || f.field).toLowerCase() + ' is a one-character language key' +
      (same ? ')' : '; ABAP truncates ' + f.lit + ' to ' + f.quote + f.value.charAt(0) + f.quote + ', which is another language)'),
    edits,
  };
}

/**
 * Source check for MESSAGE GXD: an Open SQL statement on a static SAP table compares a language field with a two-letter
 * literal. Tables of the customer namespace (Z* / Y*) may define such a field with two characters, so they are left to ATC;
 * dynamic tables (FROM (lv_tab)) are not checked by the syntax check either.
 */
function languageLiteralInSql(s) {
  const u = s.upper;
  if (!/^(?:SELECT(?:\s|\()|OPEN\s+CURSOR\b)/.test(u) || /\bFROM\s*\(/.test(u) || /\bFROM\s+@/.test(u)) return null;
  const tables = [];
  const re = /\b(?:FROM|JOIN)\s+([A-Z\/][\w\/]*)/g;
  let m;
  while ((m = re.exec(u)) !== null) tables.push(m[1]);
  if (!tables.length || tables.some((t) => /^[ZY]/.test(t))) return null;
  return languageEdits(s, null, '');
}

module.exports = { clientSpecifiedToUsingClient, usingClientBlocker, languageLiteral, languageLiteralInSql };
