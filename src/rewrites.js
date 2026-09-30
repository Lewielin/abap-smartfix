'use strict';

/**
 * Code rewrites (Auto Fix).
 *
 * Each rewrite function takes (statement, ctx) and returns:
 *   { safety, summary, edits } or null (the statement cannot be rewritten safely; left to annotation or manual fixing)
 *
 *   safety  'safe'   semantically equivalent, applied directly when fixMode = auto
 *           'review' changes behavior (ordering, removed declarations…), applied only when fixMode = rewrite
 *                    or ruleFixModes sets rewrite
 *   edits   [{ line, col, endLine, endCol, text, order }], 0-based;
 *           endLine/endCol equal to line/col means a pure insert.
 *           '\n' in the text is replaced with the file's own line break when applied.
 *
 * Every rewrite touches only the words it must; the rest of the layout, letter case and comments stay as they are.
 */

const { PSEUDO_TO_PRAGMA } = require('./pseudo-pragmas');
const SX = require('./syntax');

// Order of inserts at the same position: code rewrite < pragma < pseudo comment < new next line
const ORDER = { inline: 0, pragma: 1, pseudo: 2, newline: 3 };

// Simple operand: a literal or a name without spaces (ls-a, <fs>, me->x, 'a b')
const OP = "(?:'(?:[^']|'')*'|`(?:[^`]|``)*`|[^\\s'`|]+)";
const re = (src) => new RegExp('^' + src + '$', 'i');

const RE_DESCRIBE = re('DESCRIBE\\s+TABLE\\s+(' + OP + ')\\s+LINES\\s+(' + OP + ')');
const RE_REFRESH = re('REFRESH\\s+([A-Za-z_<\\/][\\w<>\\/\\-~]*(?:\\[\\])?)');
const RE_CALL_METHOD = re(
  'CALL\\s+METHOD\\s+([A-Za-z_\\/][\\w\\/~]*(?:(?:->|=>)[A-Za-z_\\/][\\w\\/~]*)*)'
);

// ---------------------------------------------------------------- shared helpers

function ins(line, col, text, order) {
  return { line, col, endLine: line, endCol: col, text, order: order == null ? ORDER.inline : order };
}

function del(line, col, endCol) {
  return { line, col, endLine: line, endCol, text: '', order: ORDER.inline };
}

function indentOf(line) {
  return ((line || '').match(/^[ \t]*/) || [''])[0];
}

/** Whether there is more code after the terminator (ignoring the end-of-line comment) */
function codeAfterTerminator(ctx, s) {
  if (!s.terminator) return true;
  const line = ctx.lines[s.endLine] || '';
  const cm = ctx.comments[s.endLine];
  const stop = cm && !cm.fullLine ? cm.col : line.length;
  return /\S/.test(line.slice(s.endCol + 1, stop));
}

/** Whether there is other code before the statement start on the same line */
function codeBeforeStart(ctx, s) {
  return /\S/.test((ctx.lines[s.startLine] || '').slice(0, s.startCol));
}

/** Whether a comment sits inside the statement (before its last line); replacing the whole statement would drop it */
function hasInnerComments(ctx, s) {
  for (let li = s.startLine; li < s.endLine; li++) {
    if (ctx.comments[li]) return true;
  }
  return false;
}

/** Whether this statement can be replaced as a whole */
function canReplaceWhole(ctx, s) {
  return !s.chained && !!s.terminator && s.pragmas.length === 0 && !hasInnerComments(ctx, s);
}

/** Replace the whole statement (without the terminator) with new text */
function replaceWhole(s, text) {
  return [{ line: s.startLine, col: s.startCol, endLine: s.endLine, endCol: s.endCol, text, order: ORDER.inline }];
}

/** The last word that is not a pragma */
function lastCodeWord(words) {
  for (let i = words.length - 1; i >= 0; i--) {
    if (!/^##/.test(words[i].text)) return words[i];
  }
  return null;
}

function indexOfWord(words, upper, from) {
  for (let i = from || 0; i < words.length; i++) if (words[i].upper === upper) return i;
  return -1;
}

/** Delete word i (together with the whitespace up to the next word) */
function deleteWord(words, i) {
  const w = words[i];
  const next = words[i + 1];
  if (next && next.line === w.line) return del(w.line, w.col, next.col);
  const prev = words[i - 1];
  if (prev && prev.line === w.line) return del(w.line, prev.endCol, w.endCol);
  return del(w.line, w.col, w.endCol);
}

/**
 * Delete a keyword (such as EXPORTING); when it is alone on its line, delete the whole line so no blank line is left.
 * Do not delete across lines when the previous word's line has an end-of-line comment, so the comment is kept.
 */
function deleteKeyword(ctx, words, i) {
  const w = words[i];
  const prev = words[i - 1];
  const next = words[i + 1];
  const alone = (!prev || prev.line !== w.line) && (!next || next.line !== w.line) && !ctx.comments[w.line];
  if (alone && prev && prev.line < w.line && !ctx.comments[prev.line]) {
    const prevLen = (ctx.lines[prev.line] || '').length;
    if (prev.endCol === prevLen || !/\S/.test(ctx.lines[prev.line].slice(prev.endCol))) {
      return { line: prev.line, col: prevLen, endLine: w.line, endCol: w.endCol, text: '', order: ORDER.inline };
    }
  }
  return deleteWord(words, i);
}

/** Put * in column 0 of every line of the statement, turning it into full-line comments */
function commentOut(ctx, s) {
  if (s.chained || !s.terminator) return null;
  if (codeBeforeStart(ctx, s) || codeAfterTerminator(ctx, s)) return null;
  const edits = [];
  for (let li = s.startLine; li <= s.endLine; li++) {
    if ((ctx.lines[li] || '').charAt(0) === '*') continue;
    edits.push(ins(li, 0, '*'));
  }
  return edits;
}

/**
 * Decide whether an internal table name needs [].
 * It is omitted only when there is certainly no header line: inside a class (header lines are not allowed in METHOD),
 * structure components, object attributes, field symbols, or a declaration in this file without WITH HEADER LINE / OCCURS.
 * When no declaration is found, [] is always added, because itab[] means the table body with or without a header line.
 */
function tableBody(name, s, ctx) {
  // itab[] already names the table body
  if (/\[\]$/.test(name) || /[-~]|->|=>|^</.test(name) || ctx.inMethod[s.index]) return name;
  const esc = SX.escapeRe(name);
  const declRe = new RegExp('^(?:CLASS-)?(?:DATA|STATICS)\\s+' + esc + '\\b', 'i');
  const headerRe = new RegExp('^(?:TABLES|RANGES|NODES)\\s+' + esc + '\\b|^FORM\\b.*\\bTABLES\\b.*\\b' + esc + '\\b', 'i');
  let decl = null;
  for (const st of ctx.statements) {
    if (headerRe.test(st.text)) return name + '[]';
    if (!decl && declRe.test(st.text)) decl = st;
  }
  if (decl && !/\bWITH\s+HEADER\s+LINE\b|\bOCCURS\b/i.test(decl.text)) return name;
  return name + '[]';
}

// ---------------------------------------------------------------- rewrites

/**
 * Where UP TO 1 ROWS goes: classic syntax with INTO before WHERE → right after the INTO target;
 * new syntax with INTO at the end → at the end of the statement.
 */
function upToOneRows(w) {
  const intoIdx = indexOfWord(w, 'INTO');
  const whereIdx = indexOfWord(w, 'WHERE');
  const anchor = intoIdx >= 0 && whereIdx > intoIdx ? w[whereIdx - 1] : lastCodeWord(w);
  if (!anchor) return null;
  return { anchor, edit: ins(anchor.line, anchor.endCol, ' UP TO 1 ROWS') };
}

/**
 * The pseudo comment of "SELECT .. UP TO .. ROWS without ORDER BY" (select-up-to-no-order-by, "#EC CI_NOORDER or its
 * tokenOverrides name): a rewrite to UP TO 1 ROWS would otherwise trade its finding for that one. A rewrite lists it in
 * annotate, and the fixer places it with the statement's other pseudo comments (one per line).
 */
function upToAnnotation(ctx) {
  const own = ((ctx.options && ctx.options.tokenOverrides) || {})['select-up-to-no-order-by'];
  return own && /^"#EC\s+\w+$/i.test(own) ? own.replace(/^"#EC\s+/i, '').toUpperCase() : 'CI_NOORDER';
}

/**
 * SELECT SINGLE ... → SELECT ... UP TO 1 ROWS ... ENDSELECT.
 * Same semantics (reads one row, sy-subrc = 4 when not found), but no longer triggers "SELECT SINGLE without full primary key".
 */
function selectSingleToUpTo(s, ctx) {
  const u = s.upper;
  if (s.chained || !s.terminator) return null;
  if (!/\bINTO\b/.test(u)) return null;
  if (/\bFOR\s+UPDATE\b|\bUP\s+TO\b|\bINTO\s+TABLE\b|\bAPPENDING\b|\bFOR\s+ALL\s+ENTRIES\b/.test(u)) return null;
  if (/\b(COUNT|SUM|MIN|MAX|AVG)\s*\(/.test(u)) return null;
  if (codeAfterTerminator(ctx, s)) return null;

  const w = s.words;
  if (w.length < 4 || w[0].upper !== 'SELECT' || w[1].upper !== 'SINGLE') return null;

  const edits = [deleteWord(w, 1)];
  const upTo = upToOneRows(w);
  if (!upTo || upTo.anchor === w[1]) return null;
  edits.push(upTo.edit);

  const endLen = (ctx.lines[s.endLine] || '').length;
  edits.push(ins(s.endLine, endLen, '\n' + indentOf(ctx.lines[s.startLine]) + 'ENDSELECT.', ORDER.newline));

  const note = upToAnnotation(ctx);
  return {
    safety: 'safe',
    summary: 'SELECT SINGLE → SELECT … UP TO 1 ROWS … ENDSELECT "#EC ' + note,
    edits,
    annotate: [note],
  };
}

/** SELECT * FROM a single table → add ORDER BY PRIMARY KEY */
function addOrderByPrimaryKey(s, ctx) {
  const u = s.upper;
  if (s.chained || !s.terminator) return null;
  if (!/^SELECT\s+\*\s+FROM\s+[A-Z_\/]/.test(u)) return null;
  if (/\bJOIN\b|\bFOR\s+ALL\s+ENTRIES\b|\bGROUP\s+BY\b|\bUP\s+TO\b|\bPACKAGE\s+SIZE\b|\bUNION\b|\bHAVING\b/.test(u)) {
    return null;
  }

  const w = s.words;
  const intoIdx = indexOfWord(w, 'INTO');
  const whereIdx = indexOfWord(w, 'WHERE');
  let edit;
  if (whereIdx >= 0 && intoIdx > whereIdx) {
    // New syntax: ... WHERE ... ORDER BY PRIMARY KEY INTO TABLE @lt
    edit = ins(w[intoIdx].line, w[intoIdx].col, 'ORDER BY PRIMARY KEY ');
  } else {
    const last = lastCodeWord(w);
    if (!last) return null;
    edit = ins(last.line, last.endCol, ' ORDER BY PRIMARY KEY');
  }
  return { safety: 'review', summary: 'Add ORDER BY PRIMARY KEY', edits: [edit] };
}

/** BREAK-POINT / BREAK user → comment out the whole line */
function commentOutBreakpoint(s, ctx) {
  const edits = commentOut(ctx, s);
  return edits ? { safety: 'safe', summary: 'Comment out breakpoint', edits } : null;
}

/** Delete the lines of the statement (only when it has its lines to itself and no comments) */
function deleteLines(ctx, s) {
  if (s.chained || !s.terminator || codeBeforeStart(ctx, s) || codeAfterTerminator(ctx, s)) return null;
  for (let li = s.startLine; li <= s.endLine; li++) if (ctx.comments[li]) return null;
  const endLen = (ctx.lines[s.endLine] || '').length;
  if (s.endLine + 1 < ctx.lines.length) {
    return [{ line: s.startLine, col: 0, endLine: s.endLine + 1, endCol: 0, text: '', order: ORDER.inline }];
  }
  if (s.startLine === 0) return [{ line: 0, col: 0, endLine: s.endLine, endCol: endLen, text: '', order: ORDER.inline }];
  const prevLen = (ctx.lines[s.startLine - 1] || '').length;
  return [{ line: s.startLine - 1, col: prevLen, endLine: s.endLine, endCol: endLen, text: '', order: ORDER.inline }];
}

/**
 * Unused declaration, following abap-cleaner UnusedVariablesRule (another include might use a global, so it needs review):
 *   local variable never used                  → delete
 *   local constant, global, or only used in commented-out code → comment out with *
 *   only assigned by MESSAGE … INTO            → no rewrite (##NEEDED is the fix)
 */
function commentOutDeclaration(s, ctx) {
  const info = (ctx.unusedDecl && ctx.unusedDecl.get && ctx.unusedDecl.get(s.index)) || {};
  if (info.msgOnly) return null;
  if (info.local && !info.constant && !info.inComments) {
    const removed = deleteLines(ctx, s);
    if (removed) return { safety: 'review', summary: 'Delete unused variable', edits: removed };
  }
  const edits = commentOut(ctx, s);
  return edits ? { safety: 'review', summary: 'Comment out unused declaration', edits } : null;
}

function simpleReplace(regex, build, summary) {
  return (s, ctx) => {
    if (!canReplaceWhole(ctx, s)) return null;
    const m = s.text.match(regex);
    if (!m) return null;
    const text = build(m, s, ctx);
    if (!text) return null;
    return { safety: 'safe', summary: summary + ': ' + text, edits: replaceWhole(s, text) };
  };
}

/** Whether the target release allows the syntax (abap-smartfix.abapRelease, e.g. "7.50"; empty or "latest" = newest) */
function releaseAtLeast(ctx, version) {
  const want = String((ctx.options && ctx.options.abapRelease) || 'latest').trim();
  const num = (v) => {
    const m = /^(\d+)\.?(\d{0,2})/.exec(v);
    return m ? Number(m[1]) * 100 + Number((m[2] + '00').slice(0, 2)) : Infinity;
  };
  return num(want) >= num(version);
}

/** Source text of words[a..b], keeping the original line breaks */
function sliceWords(ctx, words, a, b) {
  const wa = words[a];
  const wb = words[b];
  if (wa.line === wb.line) return ctx.lines[wa.line].slice(wa.col, wb.endCol);
  const out = [ctx.lines[wa.line].slice(wa.col)];
  for (let li = wa.line + 1; li < wb.line; li++) out.push(ctx.lines[li]);
  out.push(ctx.lines[wb.line].slice(0, wb.endCol));
  return out.join('\n');
}

/** Index of the last word matching test outside parentheses (literals do not count), or -1 */
function lastTopLevel(words, from, test) {
  let depth = 0;
  let found = -1;
  for (let i = from; i < words.length; i++) {
    const t = words[i].text;
    if (/^['`|]/.test(t)) continue;
    if (depth === 0 && test(words[i].upper)) found = i;
    depth += (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
  }
  return depth === 0 ? found : -1;
}

/** A single operand (a word such as ls-a, <fs>, me->x, '12', ev_start+4(2)) */
const isOperand = (text) => !/\s/.test(text) && !/^##/.test(text);

/**
 * MOVE [EXACT] term TO|?TO dest. → dest = term. / dest ?= term. / dest = EXACT #( term ). (abap-cleaner MoveToRule)
 * term may be any expression, such as a functional call spanning lines.
 */
function moveToAssign(s, ctx) {
  if (!canReplaceWhole(ctx, s)) return null;
  const w = s.words;
  if (!w.length || w[0].upper !== 'MOVE') return null;
  const m = moveAssignText(w, 1, ctx);
  return m && { safety: 'safe', summary: m.summary + ': ' + m.text.replace(/\s*\n\s*/g, ' '), edits: replaceWhole(s, m.text) };
}

/** [EXACT] term TO|?TO dest (words w from index start) → { text: 'dest = term', summary }, or null */
function moveAssignText(w, start, ctx) {
  const exact = w[start] && w[start].upper === 'EXACT';
  const from = exact ? start + 1 : start;
  const to = lastTopLevel(w, from, (u) => u === 'TO' || u === '?TO');
  if (to <= from || to !== w.length - 2 || !isOperand(w[to + 1].text)) return null;
  if (exact && w[to].upper === '?TO') return null;
  const term = sliceWords(ctx, w, from, to - 1);
  const dest = w[to + 1].text;
  const text = dest + (w[to].upper === '?TO' ? ' ?= ' : ' = ') + (exact ? 'EXACT #( ' + term + ' )' : term);
  const summary = exact ? 'MOVE EXACT → EXACT #( )' : w[to].upper === '?TO' ? 'MOVE ?TO → ?=' : 'MOVE → =';
  return { text, summary };
}

/**
 * Chained MOVE: a TO b, c TO d. → b = a. / d = c. (one statement per line, at the indentation of MOVE).
 * The whole chain is replaced; every part returns the same edit (shareKey), so fixing any part fixes the chain once.
 * Only when MOVE: starts its line, no comment or pragma sits inside the chain and every part is a plain MOVE.
 */
function chainedMoveToAssign(s, ctx) {
  if (!s.chained || !/^MOVE$/i.test(s.head)) return null;
  const st = ctx.statements;
  let a = s.index;
  while (a > 0 && st[a - 1].chained && st[a - 1].head === s.head && st[a - 1].terminator === ',') a--;
  let b = s.index;
  while (b < st.length - 1 && st[b].terminator === ',' && st[b + 1].chained && st[b + 1].head === s.head) b++;
  const parts = st.slice(a, b + 1);
  if (st[b].terminator !== '.' || parts.some((p) => p.pragmas.length)) return null;

  // The keyword before the colon, on the line of the first part or up to two lines above, with nothing in front of it
  const first = parts[0];
  let kw = null;
  for (let li = first.startLine; li >= Math.max(0, first.startLine - 2) && !kw; li--) {
    const text = li === first.startLine ? ctx.lines[li].slice(0, first.startCol) : ctx.lines[li];
    const m = /^(\s*)MOVE(?=\s*:)/i.exec(text);
    if (m) kw = { line: li, col: m[1].length };
  }
  if (!kw) return null;
  const last = parts[parts.length - 1];
  for (let li = kw.line; li < last.endLine; li++) if (ctx.comments[li]) return null;

  const texts = [];
  for (const p of parts) {
    const m = moveAssignText(p.words, 0, ctx);
    if (!m || /\n/.test(m.text)) return null;
    texts.push(m.text);
  }
  const indent = ctx.lines[kw.line].slice(0, kw.col);
  const edits = [{
    line: kw.line, col: kw.col, endLine: last.endLine, endCol: last.endCol,
    text: texts.join('.\n' + indent), order: ORDER.inline, shareKey: 'move-chain:' + kw.line + ':' + kw.col,
  }];
  return { safety: 'safe', summary: 'MOVE → =: ' + texts.join('. '), edits };
}

const ARITH = {
  ADD: { kw: 'TO', op: '+', destFirst: false },
  SUBTRACT: { kw: 'FROM', op: '-', destFirst: false },
  MULTIPLY: { kw: 'BY', op: '*', destFirst: true },
  DIVIDE: { kw: 'BY', op: '/', destFirst: true },
};

/**
 * ADD a TO b / SUBTRACT a FROM b / MULTIPLY b BY a / DIVIDE b BY a (abap-cleaner AddToEtcRule):
 * b += a etc. from release 7.54; for older releases b = b + a (a in parentheses unless it is a single operand,
 * so MULTIPLY b BY c + 1 keeps its meaning and SUBTRACT -1 FROM b does not become b - -1).
 */
function arithmeticToAssign(s, ctx) {
  if (!canReplaceWhole(ctx, s)) return null;
  const w = s.words;
  const spec = w.length >= 4 && ARITH[w[0].upper];
  if (!spec) return null;
  let dest;
  let term;
  if (spec.destFirst) {
    if (!isOperand(w[1].text) || w[2].upper !== spec.kw) return null;
    dest = w[1].text;
    term = sliceWords(ctx, w, 3, w.length - 1);
  } else {
    const k = lastTopLevel(w, 1, (u) => u === spec.kw);
    if (k < 2 || k !== w.length - 2 || !isOperand(w[k + 1].text)) return null;
    dest = w[k + 1].text;
    term = sliceWords(ctx, w, 1, k - 1);
  }
  let text;
  if (releaseAtLeast(ctx, '7.54')) {
    text = dest + ' ' + spec.op + '= ' + term;
  } else {
    const simple = isOperand(term) && !/^-/.test(term);
    text = dest + ' = ' + dest + ' ' + spec.op + ' ' + (simple ? term : '( ' + term + ' )');
  }
  return {
    safety: 'safe',
    summary: w[0].upper + ' → ' + spec.op + (releaseAtLeast(ctx, '7.54') ? '=' : '') + ': ' + text.replace(/\s*\n\s*/g, ' '),
    edits: replaceWhole(s, text),
  };
}

/** Statements of the processing block (FORM / METHOD / event …) that contains statement i */
function blockOf(ctx, i) {
  let a = i;
  while (a > 0 && !SX.isUnitBoundary(ctx.statements[a].upper)) a--;
  let b = i;
  while (b < ctx.statements.length - 1 && !SX.isUnitBoundary(ctx.statements[b + 1].upper)) b++;
  return ctx.statements.slice(a, b + 1);
}

/**
 * DESCRIBE TABLE itab LINES n. → n = lines( itab ). (abap-cleaner DescribeTableRule)
 * Not rewritten when the block evaluates SY-TFILL / SY-TLENG, which only DESCRIBE TABLE sets.
 */
function describeToLines(s, ctx) {
  if (!canReplaceWhole(ctx, s)) return null;
  const m = s.text.match(RE_DESCRIBE);
  if (!m) return null;
  if (blockOf(ctx, s.index).some((st) => /\bSY-(?:TFILL|TLENG)\b/.test(st.upper))) return null;
  const text = m[2] + ' = lines( ' + tableBody(m[1], s, ctx) + ' )';
  return { safety: 'safe', summary: 'DESCRIBE TABLE → lines( ): ' + text, edits: replaceWhole(s, text) };
}
const refreshToClear = simpleReplace(
  RE_REFRESH,
  (m, s, ctx) => 'CLEAR ' + tableBody(m[1], s, ctx),
  'REFRESH → CLEAR'
);
/**
 * The client field compared with the current client in the WHERE of Open SQL without CLIENT SPECIFIED / USING CLIENT
 * (… AND a~mandt = sy-mandt): the condition is what automatic client handling adds anyway, so removing it keeps the result.
 * Only "= sy-mandt" joined by AND is removed; another value or the only condition of the WHERE is left for a manual fix.
 */
function clientConditionWords(s) {
  const w = s.words;
  let inWhere = false;
  for (let i = 0; i < w.length; i++) {
    const u = w[i].upper;
    if (u === 'WHERE') { inWhere = true; continue; }
    if (/^(?:ORDER|GROUP|HAVING|INTO|APPENDING|UP|FIELDS)$/.test(u)) inWhere = false;
    if (!inWhere || !/^(?:[\w\/]+~)?(?:MANDT|CLIENT)$/.test(u)) continue;
    if (!w[i + 1] || !/^(?:=|EQ)$/.test(w[i + 1].upper) || !w[i + 2]) continue;
    return { i, value: w[i + 2].upper.replace(/^@/, '') };
  }
  return null;
}

function removeClientCondition(s, ctx) {
  if (s.chained || !s.terminator || s.pragmas.length || hasInnerComments(ctx, s)) return null;
  const hit = clientConditionWords(s);
  if (!hit || hit.value !== 'SY-MANDT') return null;
  const w = s.words;
  const i = hit.i;
  let from;
  let to;
  if (w[i - 1] && w[i - 1].upper === 'AND' && w[i - 2]) {
    // … <cond> AND a~mandt = sy-mandt → … <cond>
    from = { line: w[i - 2].line, col: w[i - 2].endCol };
    to = { line: w[i + 2].line, col: w[i + 2].endCol };
  } else if (w[i - 1] && w[i - 1].upper === 'WHERE' && w[i + 3] && w[i + 3].upper === 'AND' && w[i + 4]) {
    // WHERE a~mandt = sy-mandt AND <cond> → WHERE <cond>
    from = { line: w[i].line, col: w[i].col };
    to = { line: w[i + 4].line, col: w[i + 4].col };
  } else return null;
  return {
    safety: 'safe',
    summary: 'Remove the client condition ' + sliceWords(ctx, w, i, i + 2).replace(/\s+/g, ' '),
    edits: [{ line: from.line, col: from.col, endLine: to.line, endCol: to.col, text: '', order: ORDER.inline }],
  };
}

/**
 * Chained REFRESH: a, b. → CLEAR: a[], b[]. (as refreshToClear, [] where a header line cannot be ruled out).
 * Every part of the chain returns the same edits (shareKey), so fixing any part fixes the whole chain once.
 */
function chainedRefreshToClear(s, ctx) {
  if (!s.chained || !/^REFRESH$/i.test(s.head)) return null;
  const st = ctx.statements;
  let a = s.index;
  while (a > 0 && st[a - 1].chained && st[a - 1].head === s.head && st[a - 1].terminator === ',') a--;
  let b = s.index;
  while (b < st.length - 1 && st[b].terminator === ',' && st[b + 1].chained && st[b + 1].head === s.head) b++;
  const parts = st.slice(a, b + 1);
  if (st[b].terminator !== '.' || parts.some((p) => p.pragmas.length || p.words.length !== 1 || !/^REFRESH\s+[^\s]+$/.test(p.upper))) return null;
  if (parts.some((p) => /\bFROM\b|^REFRESH\s+CONTROL\b/.test(p.upper))) return null;

  // The keyword before the colon, on the line of the first part or up to two lines above
  const first = parts[0];
  let kw = null;
  for (let li = first.startLine; li >= Math.max(0, first.startLine - 2) && !kw; li--) {
    const text = li === first.startLine ? ctx.lines[li].slice(0, first.startCol) : ctx.lines[li];
    const m = /\bREFRESH(?=\s*:)/i.exec(text);
    if (m) kw = { line: li, col: m.index };
  }
  if (!kw) return null;

  const key = 'refresh-chain:' + kw.line + ':' + kw.col;
  const edits = [{ line: kw.line, col: kw.col, endLine: kw.line, endCol: kw.col + 7, text: 'CLEAR', order: ORDER.inline, shareKey: key + ':kw' }];
  const names = [];
  for (const p of parts) {
    const w = p.words[0];
    const body = tableBody(w.text, p, ctx);
    names.push(body);
    if (body !== w.text) edits.push({ line: w.line, col: w.endCol, endLine: w.line, endCol: w.endCol, text: body.slice(w.text.length), order: ORDER.inline, shareKey: key + ':' + w.line + ':' + w.col });
  }
  return { safety: 'safe', summary: 'REFRESH → CLEAR: CLEAR: ' + names.join(', '), edits };
}

const callMethodToFunctional = simpleReplace(RE_CALL_METHOD, (m) => m[1] + '( )', 'CALL METHOD → functional call');

// GET REFERENCE OF → REF #( )
const RE_GET_REF = re('GET\\s+REFERENCE\\s+OF\\s+(' + OP + ')\\s+INTO\\s+(' + OP + ')');
const getReferenceToRef = simpleReplace(RE_GET_REF, (m) => m[2] + ' = REF #( ' + m[1] + ' )', 'GET REFERENCE → REF #( )');

const METHOD_NAME = /^[A-Za-z_\/][\w\/~]*(?:(?:->|=>)[A-Za-z_\/][\w\/~]*)*$/;
const PARAM_KW = /^(?:EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)$/;

/**
 * CALL METHOD m [EXPORTING …] RECEIVING r = x. → x = m( … ). (abap-cleaner CallMethodRule together with "Omit RECEIVING")
 * Only when there is nothing but EXPORTING and one RECEIVING r = x at the end, and no comment in the removed part.
 */
function receivingToAssign(ctx, w, sections, last) {
  if (!sections.length || sections.some((x) => x.upper !== 'EXPORTING' && x.upper !== 'RECEIVING')) return null;
  const recv = sections.filter((x) => x.upper === 'RECEIVING');
  if (recv.length !== 1) return null;
  const r = w.indexOf(recv[0]);
  if (r !== w.length - 4 || w[r + 3] !== last || w[r + 2].text !== '=') return null;
  const prev = w[r - 1];
  for (let li = prev.line; li < last.line; li++) if (ctx.comments[li]) return null;

  const target = last.text;
  const edits = [{ line: w[0].line, col: w[0].col, endLine: w[2].line, endCol: w[2].col, text: target + ' = ', order: ORDER.inline }];
  if (prev === w[2]) {
    edits.push({ line: w[2].line, col: w[2].endCol, endLine: last.line, endCol: last.endCol, text: '( )', order: ORDER.inline });
  } else {
    edits.push(ins(w[2].line, w[2].endCol, '('));
    edits.push({ line: prev.line, col: prev.endCol, endLine: last.line, endCol: last.endCol, text: ' )', order: ORDER.inline });
    edits.push(deleteKeyword(ctx, w, 3));
  }
  return { safety: 'safe', summary: 'CALL METHOD … RECEIVING → ' + target + ' = ' + w[2].text + '( … )', edits };
}

/**
 * CALL METHOD obj->m EXPORTING a = 1 IMPORTING b = c. → obj->m( EXPORTING a = 1 IMPORTING b = c ).
 * With only EXPORTING the keyword is omitted: obj->m( a = 1 ).
 * Only CALL METHOD is removed and parentheses are added; the rest of the layout and comments stay as they are.
 * Dynamic calls (CALL METHOD (name) / obj->(name)), PARAMETER-TABLE and EXCEPTION-TABLE are not rewritten.
 */
function callMethodWithParams(s, ctx) {
  if (s.chained || !s.terminator || s.pragmas.length) return null;
  const w = s.words;
  if (w.length < 4 || w[0].upper !== 'CALL' || w[1].upper !== 'METHOD') return null;
  if (!METHOD_NAME.test(w[2].text) || !PARAM_KW.test(w[3].upper)) return null;
  if (/\b(?:PARAMETER-TABLE|EXCEPTION-TABLE)\b/.test(s.upper)) return null;
  const last = lastCodeWord(w);
  if (!last || last === w[2] || w[0].line !== w[2].line) return null;

  const sections = w.slice(3).filter((x) => PARAM_KW.test(x.upper));
  const receiving = receivingToAssign(ctx, w, sections, last);
  if (receiving) return receiving;
  const onlyExporting = sections.length === 1 && sections[0].upper === 'EXPORTING';
  const edits = [
    del(w[0].line, w[0].col, w[2].col), // CALL METHOD␠
    ins(w[2].line, w[2].endCol, '('),
    ins(last.line, last.endCol, ' )'),
  ];
  if (onlyExporting) edits.push(deleteKeyword(ctx, w, 3));
  return {
    safety: 'safe',
    summary: 'CALL METHOD → ' + w[2].text + '( ' + (onlyExporting ? '' : w[3].upper + ' ') + '… )',
    edits,
  };
}

/**
 * Whether the target of CREATE OBJECT is read in its own parameter list (abap-cleaner CreateObjectRule):
 * CREATE OBJECT assigns the target first, NEW only at the end, so
 * "CREATE OBJECT lo EXPORTING iv = lo->gc_value" would change meaning. A formal parameter with the same name (lo = …) is fine.
 */
function targetUsedInParams(words, from, targetUpper) {
  for (let j = from; j < words.length; j++) {
    if (words[j + 1] && words[j + 1].text === '=') continue;
    const u = words[j].upper;
    if (u === targetUpper) return true;
    if (u.indexOf(targetUpper) === 0 && /^[^\w\/]/.test(u.slice(targetUpper.length))) return true;
  }
  return false;
}

/**
 * CREATE OBJECT o [TYPE cls] [EXPORTING p = v]. → o = NEW #( p = v ). / o = NEW cls( p = v ).
 * Not rewritten with EXCEPTIONS, AREA HANDLE, a dynamic type TYPE (name), PARAMETER-TABLE (NEW has no equivalent),
 * or when the target is read in the parameter list.
 */
function createObjectToNew(s, ctx) {
  if (s.chained || !s.terminator || s.pragmas.length) return null;
  const w = s.words;
  if (w.length < 3 || w[0].upper !== 'CREATE' || w[1].upper !== 'OBJECT') return null;
  if (/\b(?:EXCEPTIONS|AREA\s+HANDLE|PARAMETER-TABLE|EXCEPTION-TABLE|FOR\s+TESTING)\b/.test(s.upper)) return null;
  const target = w[2];
  if (!/^[A-Za-z_<\/][\w<>\/\-~]*(?:(?:->|=>)[\w\/~]+)*$/.test(target.text)) return null;

  let i = 3;
  let type = '#';
  let headLast = target;
  if (w[i] && w[i].upper === 'TYPE') {
    if (!w[i + 1] || /^\(/.test(w[i + 1].text)) return null;
    type = w[i + 1].text;
    headLast = w[i + 1];
    i += 2;
  }
  const last = lastCodeWord(w);
  if (w[i] && (w[i].upper !== 'EXPORTING' || last === w[i])) return null;
  if (w[0].line !== headLast.line) return null;
  if (targetUsedInParams(w, i, target.upper)) return null;

  // CREATE OBJECT o [TYPE t] → o = NEW t( ; EXPORTING is removed, parameters keep their layout, ) is added at the end
  const open = target.text + ' = NEW ' + type + '(';
  const edits = [];
  if (w[i]) {
    edits.push({ line: w[0].line, col: w[0].col, endLine: headLast.line, endCol: headLast.endCol, text: open, order: ORDER.inline });
    edits.push(deleteKeyword(ctx, w, i));
    edits.push(ins(last.line, last.endCol, ' )'));
  } else {
    edits.push({ line: w[0].line, col: w[0].col, endLine: headLast.line, endCol: headLast.endCol, text: open + ' )', order: ORDER.inline });
  }
  return { safety: 'safe', summary: 'CREATE OBJECT → ' + open + ' … )', edits };
}

/**
 * Custom rule rewrite: String.replace on the whole statement text (without the period).
 * For example match "^WRITE\\s+(\\S+)$", replace "cl_demo_output=>write( $1 )".
 */
function customReplace(regex, replacement, safety, title) {
  return (s, ctx) => {
    if (!canReplaceWhole(ctx, s)) return null;
    const flags = regex.flags.replace('g', '');
    const text = s.text.replace(new RegExp(regex.source, flags), replacement);
    if (!text.trim() || text === s.text) return null;
    return { safety, summary: title + ': ' + text, edits: replaceWhole(s, text) };
  };
}

/**
 * Pseudo comments of the extended program check (SLIN) that are obsolete, and their pragmas (full SLIN_DESC table).
 * Code Inspector "#EC CI_… comments are still valid and are not listed.
 */
const OBSOLETE_PSEUDO = PSEUDO_TO_PRAGMA;

/**
 * The obsolete pseudo comment of an end-of-line comment, or null.
 * As in abap-cleaner, only a valid pseudo comment is converted: "#EC directly after the ", exactly one space,
 * and the code in upper case (otherwise SLIN ignores it too). Any later #EC on the line is plain text and stays as it is.
 * @returns {{name: string, pragma: string, rest: string}|null} rest is the comment text after the code
 */
function obsoletePseudoOf(commentText, map) {
  const table = map || OBSOLETE_PSEUDO;
  const m = /^"#[Ee][Cc] ([A-Z0-9_]+)(?![\w*])([\s\S]*)$/.exec(commentText || '');
  if (!m || !table[m[1]]) return null;
  return { name: m[1], pragma: table[m[1]], rest: m[2] };
}

/**
 * "#EC NEEDED → ##NEEDED: remove the pseudo comment from the end-of-line comment and add the pragma before the terminator.
 * The text after it is kept as a regular comment ("#EC NO_HANDLER nothing to do → ##NO_HANDLER. " nothing to do).
 * A pseudo comment right after a chain colon (DATA: "#EC NEEDED) is left alone: a pragma before the colon
 * would apply to every part of the chain, which the pseudo comment does not.
 */
function pseudoToPragma(s, ctx) {
  return replacePseudoWithPragma(s, ctx, OBSOLETE_PSEUDO);
}

/**
 * Replace the pseudo comments named in map (name → pragma) on statement s by their pragmas, as pseudoToPragma does.
 * Also used for a pseudo comment of the wrong check, e.g. "#EC CI_SUBRC on CALL FUNCTION → ##FM_SUBRC_OK.
 */
function replacePseudoWithPragma(s, ctx, map) {
  if (!s.terminator) return null;

  const edits = [];
  const names = [];
  for (let li = s.startLine; li <= s.endLine; li++) {
    const cm = ctx.comments[li];
    if (!cm || cm.fullLine) continue;
    const found = obsoletePseudoOf(cm.text, map);
    if (!found) continue;
    const line = ctx.lines[li];
    const code = line.slice(0, cm.col).replace(/[ \t]+$/, '');
    if (/:$/.test(code)) continue;

    const rest = found.rest.trim();
    if (!rest || rest === '.') {
      // Nothing else in the comment: delete it together with the preceding whitespace
      edits.push(del(li, code.length, line.length));
    } else {
      const text = /^"/.test(rest) && !/^"#EC\b/i.test(rest) ? rest : '" ' + rest;
      edits.push({ line: li, col: cm.col, endLine: li, endCol: line.length, text, order: ORDER.inline });
    }
    if (names.indexOf(found.name) < 0) names.push(found.name);
  }
  if (!edits.length) return null;

  const pragmas = [];
  for (const n of names) {
    const p = map[n];
    if (pragmas.indexOf(p) < 0 && s.pragmas.indexOf(p) < 0) pragmas.push(p);
  }
  if (pragmas.length) {
    const before = (ctx.lines[s.endLine] || '').charAt(s.endCol - 1);
    const prefix = before && before !== ' ' && before !== '\t' ? ' ' : '';
    edits.push(ins(s.endLine, s.endCol, prefix + pragmas.join(' ')));
  }

  const from = names.map((n) => '"#EC ' + n).join(' ');
  const to = names.map((n) => map[n]).join(' ');
  return { safety: 'safe', summary: from + ' → ' + to, edits };
}

/** COMPUTE x = ... → x = ... (only the word COMPUTE is removed) */
function dropCompute(s) {
  const w = s.words;
  if (s.chained || w.length < 2 || w[0].upper !== 'COMPUTE' || w[1].upper === 'EXACT') return null;
  return { safety: 'safe', summary: 'Remove redundant COMPUTE', edits: [deleteWord(w, 0)] };
}

module.exports = {
  ORDER,
  // helpers shared with rewrites-sci.js
  ins,
  del,
  indentOf,
  codeAfterTerminator,
  codeBeforeStart,
  sliceWords,
  releaseAtLeast,
  tableBody,
  upToOneRows,
  upToAnnotation,
  deleteLines,
  blockOf,
  selectSingleToUpTo,
  addOrderByPrimaryKey,
  commentOutBreakpoint,
  commentOutDeclaration,
  moveToAssign,
  arithmeticToAssign,
  describeToLines,
  refreshToClear,
  chainedRefreshToClear,
  chainedMoveToAssign,
  clientConditionWords,
  removeClientCondition,
  callMethodToFunctional,
  callMethodWithParams,
  getReferenceToRef,
  createObjectToNew,
  dropCompute,
  customReplace,
  pseudoToPragma,
  replacePseudoWithPragma,
};
