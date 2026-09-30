'use strict';

/**
 * Code rewrites for the performance / robustness checks in rules-sci.js.
 *
 * Same contract as rewrites.js: return { safety, summary, edits } or null, touch only the words that must change,
 * never re-indent or reformat the rest of the customer's code. Anything that changes behavior is 'review'.
 */

const RW = require('./rewrites');
const SX = require('./syntax');

const { ORDER, ins } = RW;
const { escapeRe } = SX;

/** Keyword text in the letter case of the code around it (sample: an existing keyword of the statement) */
function kw(sample, text) {
  return sample && sample === sample.toLowerCase() ? text.toLowerCase() : text;
}

/** Whether the statement mentions the data object name (as a whole name, also name-comp and name[]) */
function mentions(st, name) {
  return new RegExp('(?:^|[^\\w<>\\/-])@?' + escapeRe(name) + '(?![\\w<>\\/])', 'i').test(st.text);
}

/** Whether the statement has its lines to itself and no comments on them */
function ownLines(ctx, s) {
  if (s.chained || !s.terminator || RW.codeBeforeStart(ctx, s) || RW.codeAfterTerminator(ctx, s)) return false;
  for (let li = s.startLine; li <= s.endLine; li++) if (ctx.comments[li]) return false;
  return true;
}

/**
 * Whether the value a variable has after statement i is still read later in the block:
 * the first later statement that names it must overwrite it (LOOP AT … INTO wa, READ TABLE … INTO wa, SELECT … INTO wa,
 * CLEAR wa, wa = …); anything else counts as a read.
 */
function valueUsedAfter(ctx, i, name) {
  const n = escapeRe(name.toUpperCase());
  const writes = new RegExp(
    '^(?:(?:LOOP\\s+AT|READ\\s+TABLE|SELECT|FETCH)\\b.*\\bINTO\\s+(?:CORRESPONDING\\s+FIELDS\\s+OF\\s+)?@?' + n + '(?:\\s|$)' +
      '|(?:CLEAR|FREE)\\s+' + n + '$|' + n + '\\s*=\\s)'
  );
  for (const st of RW.blockOf(ctx, i)) {
    if (st.index <= i || !mentions(st, name)) continue;
    // wa = wa-comp + 1 reads it on the right-hand side
    return !writes.test(st.upper) || new RegExp('(?:^|[^\\w<>\\/])' + n + '(?![\\w<>\\/])').test(st.upper.replace(writes, ''));
  }
  return false;
}

function innermostLoop(ctx, i) {
  const loops = ctx.loops.enclosing[i];
  return loops.length ? loops[loops.length - 1] : -1;
}

/**
 * LOOP AT itab INTO wa. MODIFY dbtab FROM wa. ENDLOOP. → MODIFY dbtab FROM TABLE itab.
 * Also UPDATE / DELETE, and ASSIGNING <fs>. Only when the loop body is exactly that one statement and wa is not used after
 * the loop. INSERT is left alone: INSERT … FROM TABLE dumps on a duplicate key instead of setting sy-subrc per row.
 */
function loopToArrayOperation(s, ctx) {
  const li = innermostLoop(ctx, s.index);
  if (li !== s.index - 1 || ctx.loops.end.get(li) !== s.index + 1) return null;
  const loop = ctx.statements[li];
  const close = ctx.statements[s.index + 1];
  const lm = loop.upper.match(/^LOOP\s+AT\s+(\S+)\s+(?:INTO|ASSIGNING)\s+(\S+)$/);
  const om = s.upper.match(/^(?:MODIFY|UPDATE|DELETE)\s+(\S+)\s+FROM\s+(\S+)$/);
  if (!lm || !om || /^\(/.test(om[1])) return null;
  const wa = SX.baseName(lm[2]);
  if (SX.baseName(om[2]) !== wa) return null;
  if (![loop, s, close].every((st) => ownLines(ctx, st) && !st.pragmas.length)) return null;
  if (valueUsedAfter(ctx, close.index, wa)) return null;

  const w = s.words;
  const text = w[0].text + ' ' + w[1].text + ' ' + kw(w[2].text, 'FROM TABLE') + ' ' + loop.words[2].text.replace(/\[\]$/, '');
  return {
    safety: 'review',
    summary: 'LOOP … ' + w[0].upper + ' … FROM ' + lm[2].toLowerCase() + ' … ENDLOOP → ' + text,
    edits: [{ line: loop.startLine, col: loop.startCol, endLine: close.endLine, endCol: close.endCol, text, order: ORDER.inline }],
  };
}

/**
 * SORT inside a loop → move it in front of the innermost loop, when the loop never changes the table
 * (every other statement of the loop that names it only reads it) and does not loop over it.
 * Review: if the loop runs zero times, the table is now sorted anyway.
 */
function hoistSortBeforeLoop(s, ctx) {
  const li = innermostLoop(ctx, s.index);
  if (li < 0 || s.startLine !== s.endLine || !ownLines(ctx, s)) return null;
  const loop = ctx.statements[li];
  if (RW.codeBeforeStart(ctx, loop)) return null;
  const w = s.words;
  const table = SX.baseName(w[1] && w[1].text);
  if (!table || /^\(/.test(table)) return null;
  if (/^(?:LOOP\s+AT|READ\s+TABLE)\s/.test(loop.upper) && SX.baseName(loop.words[2].text) === table) return null;
  const end = ctx.loops.end.get(li);
  if (end == null) return null;
  const readOnly = new RegExp('^(?:READ\\s+TABLE|LOOP\\s+AT)\\s+@?' + escapeRe(table.toUpperCase()) + '(?:\\[\\])?\\s');
  for (let j = li + 1; j < end; j++) {
    const st = ctx.statements[j];
    if (j === s.index || !mentions(st, table)) continue;
    if (!readOnly.test(st.upper)) return null;
    // LOOP AT itab … inside the loop may still change it through MODIFY / DELETE, which name the table again
  }
  const del = RW.deleteLines(ctx, s);
  if (!del) return null;
  const code = ctx.lines[s.startLine].slice(s.startCol).replace(/\s+$/, '');
  return {
    safety: 'review',
    summary: 'Move ' + code + ' in front of the loop in line ' + (loop.startLine + 1),
    edits: [ins(loop.startLine, 0, RW.indentOf(ctx.lines[loop.startLine]) + code + '\n')].concat(del),
  };
}

/**
 * SELECT … ENDSELECT whose last statement is an unconditional EXIT → SELECT … UP TO 1 ROWS … ENDSELECT without the EXIT.
 * Same rows, same sy-subrc and sy-dbcnt; the database stops after one row instead of preparing a whole result set.
 */
function selectExitToUpTo(s, ctx) {
  const e = ctx.selectLoops.get(s.index);
  if (e == null || s.chained || !s.terminator) return null;
  if (/\bUP\s+TO\b|\bPACKAGE\s+SIZE\b|\bINTO\s+(?:CORRESPONDING\s+FIELDS\s+OF\s+)?TABLE\b|\bAPPENDING\b/.test(s.upper)) return null;
  const exit = ctx.statements[e - 1];
  if (!exit || exit.upper !== 'EXIT' || innermostLoop(ctx, exit.index) !== s.index) return null;
  const del = RW.deleteLines(ctx, exit);
  const upTo = RW.upToOneRows(s.words);
  if (!del || !upTo) return null;
  // UP TO without ORDER BY is reported itself (select-up-to-no-order-by): the fixer annotates it with the rewrite
  const note = /\bORDER\s+BY\b/.test(s.upper) ? '' : RW.upToAnnotation(ctx);
  return {
    safety: 'safe',
    summary: 'SELECT … ENDSELECT with EXIT → SELECT … UP TO 1 ROWS … ENDSELECT' + (note ? ' "#EC ' + note : ''),
    edits: [upTo.edit].concat(del),
    annotate: note ? [note] : [],
  };
}

/**
 * Index of the last statement of the sy-subrc handling right after statement i (IF sy-subrc … ENDIF or CHECK sy-subrc),
 * or i when there is none. Moving it into the same IF keeps a skipped SELECT from being judged by a stale sy-subrc.
 */
function subrcHandlingEnd(ctx, i) {
  const next = ctx.statements[i + 1];
  if (!next) return i;
  if (/^CHECK\b.*\bSY-SUBRC\b/.test(next.upper)) return i + 1;
  if (!/^IF\b.*\bSY-SUBRC\b/.test(next.upper)) return i;
  let depth = 0;
  for (let j = i + 1; j < ctx.statements.length; j++) {
    const u = ctx.statements[j].upper;
    if (SX.isUnitBoundary(u)) return i;
    if (/^IF(?=\s|$)/.test(u)) depth++;
    else if (/^ENDIF(?=\s|$)/.test(u) && --depth === 0) return j;
  }
  return i;
}

/**
 * SELECT … FOR ALL ENTRIES IN itab without an emptiness check → IF itab IS NOT INITIAL. … ENDIF. around it
 * (with its ENDSELECT and the sy-subrc check right after it).
 * Review: with an empty driver table the SELECT no longer reads every row, and the target table and sy-subrc are left as they were.
 */
function wrapForAllEntries(s, ctx) {
  const m = s.upper.match(/\bFOR\s+ALL\s+ENTRIES\s+IN\s+@?([^\s]+)/);
  if (!m || s.chained || !s.terminator) return null;
  const endIdx = subrcHandlingEnd(ctx, ctx.selectLoops.has(s.index) ? ctx.selectLoops.get(s.index) : s.index);
  const last = ctx.statements[endIdx];
  if (RW.codeBeforeStart(ctx, s) || RW.codeAfterTerminator(ctx, last)) return null;
  const nameWord = s.words.find((x) => x.upper.replace(/^@/, '') === m[1]);
  if (!nameWord) return null;
  const name = nameWord.text.replace(/^@/, '').replace(/\[\]$/, '');
  const table = RW.tableBody(name, s, ctx);
  const indent = RW.indentOf(ctx.lines[s.startLine]);
  const k = s.words[0].text;
  const endLen = (ctx.lines[last.endLine] || '').length;
  return {
    safety: 'review',
    summary: 'Wrap in ' + kw(k, 'IF') + ' ' + table + ' ' + kw(k, 'IS NOT INITIAL') + ' … ' + kw(k, 'ENDIF'),
    edits: [
      ins(s.startLine, 0, indent + kw(k, 'IF') + ' ' + table + ' ' + kw(k, 'IS NOT INITIAL') + '.\n'),
      ins(last.endLine, endLen, '\n' + indent + kw(k, 'ENDIF') + '.', ORDER.newline),
    ],
  };
}

module.exports = {
  loopToArrayOperation,
  hoistSortBeforeLoop,
  selectExitToUpTo,
  wrapForAllEntries,
  innermostLoop,
};
