'use strict';

const { ORDER } = require('./rewrites');
const { collectPseudo } = require('./lexer');

/**
 * Turns findings into concrete edits.
 *
 * By the action of each finding:
 *   rewrite  -> apply the code rewrite computed by rewrites.js
 *   suppress -> a pragma goes before the statement terminator (. or ,);
 *               a pseudo comment goes into the end-of-line comment (after the " if the line already has one)
 *   manual   -> reported as unfixable, left to a person or an AI assistant
 *
 * Several pragmas on one statement are inserted together (SELECT … ##A ##B.).
 * SAP allows only one pseudo comment per line, so several are spread over the lines of the statement,
 * breaking the statement before a clause keyword when there are not enough lines:
 *   SELECT * FROM t "#EC CI_NOWHERE
 *     INTO TABLE lt. "#EC CI_ALL_FIELDS_NEEDED
 * An ABAP line has at most 255 characters: a line a fix would make longer is broken (wrapLongLines), or the fix is left
 * for a manual fix when no break makes room.
 *
 * Edit format: { line, col, endLine, endCol, text, order, findings } (0-based;
 * endLine/endCol equal to line/col means a pure insert; '\n' in text becomes the file's line break)
 */

function groupByStatement(findings) {
  const map = new Map();
  for (const f of findings) {
    if (!map.has(f.stmtIndex)) map.set(f.stmtIndex, []);
    map.get(f.stmtIndex).push(f);
  }
  return map;
}

function cmpPos(l1, c1, l2, c2) {
  return l1 - l2 || c1 - c2;
}

function isInsert(e) {
  return e.line === e.endLine && e.col === e.endCol;
}

/** Whether two edits overlap (touching does not count; pure inserts at the same position are merged, not overlapping) */
function overlaps(a, b) {
  if (isInsert(a) && isInsert(b)) return false;
  return (
    cmpPos(a.line, a.col, b.endLine, b.endCol) < 0 &&
    cmpPos(b.line, b.col, a.endLine, a.endCol) < 0
  );
}

function manualReason(f) {
  if (f.atc && !f.rewrite) {
    if (f.exemption) {
      return 'ATC reports "' + f.atc.message + '" (' + f.detail + '), which no pragma or pseudo comment suppresses and SmartFix for ABAP cannot rewrite here; fix the code or request an ATC exemption';
    }
    return 'ATC reports "' + f.atc.message + '" (' + f.detail + '), which SmartFix for ABAP has no rule for; please fix it manually';
  }
  if (f.verifyFailed) {
    return 'The rewrite (' + f.rewrite.summary + ') did not pass the self-check (' + f.verifyFailed + '), so it was not applied; please fix it manually';
  }
  if (!f.rewrite) {
    return 'This statement cannot be rewritten automatically (chained statement, comment inside a multi-line statement, existing pragma, or too complex); please fix it manually';
  }
  if (f.fixMode === 'suppress') {
    return 'Suppress-only mode is active and this rule has no annotation; it can be rewritten as "' + f.rewrite.summary + '"';
  }
  return 'The rewrite changes behavior (' + f.rewrite.summary + ') and needs review: use Quick Fix, or set fixMode to rewrite';
}

/** Apply only this finding's rewrite and return the rewritten statement (for the AI prompt and preview) */
function rewritePreview(lines, f) {
  // Edits in front of the statement (e.g. the literal of a dynamic column list) are not part of the statement preview
  const own = f.rewrite.edits.filter((e) => e.line >= f.startLine);
  const last = own.reduce((m, e) => Math.max(m, e.endLine), f.endLine);
  const part = lines.slice(f.startLine, last + 1);
  const shifted = own.map((e) =>
    Object.assign({}, e, { line: e.line - f.startLine, endLine: e.endLine - f.startLine })
  );
  return applyEditsToLines(part, shifted, '\n').join('\n');
}

/**
 * @returns {{edits: Array, actions: Array, unfixable: Array}}
 *   edits:     the edits to apply
 *   actions:   one entry per fix (for reports / the AI prompt): { type, line, text, after?, findings }
 *   unfixable: [{ findings, reason }]
 */
function planEdits(lines, comments, findings) {
  const edits = [];
  const actions = [];
  const unfixable = [];
  const groups = groupByStatement(findings);

  for (const [, group] of groups) {
    const first = group[0];
    const lineText = lines[first.endLine] != null ? lines[first.endLine] : '';
    const suppress = group.filter((f) => f.action === 'suppress');

    for (const f of group) {
      if (f.action === 'manual') unfixable.push({ findings: [f], reason: manualReason(f) });
    }

    // ---- Code rewrites: when rewrites on the same statement conflict, later ones fall back to suppression (or manual)
    const taken = [];
    // Pseudo comments a rewrite needs for what it introduces (UP TO 1 ROWS → "#EC CI_NOORDER), placed with the others
    const rewriteNotes = [];
    for (const f of group) {
      if (f.action !== 'rewrite') continue;
      const mine = f.rewrite.edits;
      if (mine.some((e) => taken.some((t) => overlaps(e, t)))) {
        if (f.canSuppress) suppress.push(f);
        else unfixable.push({ findings: [f], reason: 'Conflicts with another rewrite of the same statement; please fix it manually' });
        continue;
      }
      taken.push(...mine);
      for (const e of mine) edits.push(Object.assign({}, e, { findings: [f] }));
      for (const n of f.rewrite.annotate || []) rewriteNotes.push({ name: n, finding: f });
      actions.push({
        type: 'rewrite',
        line: f.startLine,
        text: f.rewrite.summary,
        after: rewritePreview(lines, f),
        findings: [f],
      });
    }

    // ---- Annotations
    // A rewrite that replaced the whole statement with one of the same kind (LOOP … MODIFY … ENDLOOP → MODIFY … FROM TABLE):
    // the other annotations of the statement go to the rewritten statement, at the end of the replaced text
    const target = rewrittenTarget(lines, first, taken) || first;
    const pragmas = [];
    const pseudos = [];
    for (const f of suppress) {
      if (f.kind === 'pragma') {
        if (pragmas.indexOf(f.token) < 0) pragmas.push(f.token);
      } else if (pseudos.indexOf(f.tokenName) < 0) {
        pseudos.push(f.tokenName);
      }
    }

    if (pragmas.length) {
      const pragmaFindings = suppress.filter((f) => f.kind === 'pragma');
      if (!target.terminator) {
        unfixable.push({ findings: pragmaFindings, reason: 'Statement terminator (period) not found' });
      } else {
        const before = target === first ? lineText.charAt(first.endCol - 1) : 'x';
        const prefix = before && before !== ' ' && before !== '\t' ? ' ' : '';
        const text = prefix + pragmas.join(' ');
        edits.push(pointEdit(target.endLine, target.endCol, text, ORDER.pragma, pragmaFindings));
        actions.push({ type: 'pragma', line: target.endLine, text: text.trim(), findings: pragmaFindings });
      }
    }

    for (const r of rewriteNotes) if (pseudos.indexOf(r.name) < 0) pseudos.push(r.name);

    if (pseudos.length) {
      const pseudoFindings = suppress.filter((f) => f.kind === 'pseudo')
        .concat(rewriteNotes.map((r) => r.finding).filter((f, i, all) => all.indexOf(f) === i));
      placePseudos(lines, comments, target, pseudos, pseudoFindings, edits, actions, unfixable);
    }
  }

  const before = unfixable.length;
  const merged = wrapLongLines(lines, mergeEdits(edits, unfixable), findings, unfixable);
  // Fixes left out to keep lines within 255 characters are no longer reported as applied
  const dropped = new Set([].concat(...unfixable.slice(before).map((u) => u.findings)));
  const kept = dropped.size ? actions.filter((a) => !a.findings.every((f) => dropped.has(f))) : actions;
  kept.sort((a, b) => a.line - b.line);
  return { edits: merged, actions: kept, unfixable };
}

/** An ABAP source line has at most 255 characters; a longer line is a syntax error */
const MAX_LINE = 255;
/** Line breaks added to one line at most, to keep its lines within MAX_LINE */
const MAX_BREAKS = 4;

/**
 * Keep lines that get a pragma or pseudo comment within MAX_LINE characters. The edits of a line are applied to it in memory
 * (with the line breaks other fixes add), and while a resulting line is too long:
 *   1. a pragma goes to a line of its own (with the terminator and what follows it): "… WHERE a = b\n    ##NEEDED."
 *   2. otherwise the code is broken before a word of a statement (a clause keyword when possible), so the part that keeps
 *      the pseudo comment fits: "SELECT … FROM t\n    WHERE a = b. "#EC CI_X"
 * When no break makes every line fit, the annotations of the line are left for a manual fix instead of writing a line
 * ABAP rejects. Lines that a rewrite spanning several lines touches, or that were too long already, are left as they are.
 */
function wrapLongLines(lines, edits, findings, unfixable) {
  const byLine = new Map();
  for (const e of edits) {
    if (!byLine.has(e.line)) byLine.set(e.line, []);
    byLine.get(e.line).push(e);
  }
  const spanned = new Set();
  for (const e of edits) for (let li = e.line + 1; li <= e.endLine; li++) spanned.add(li);
  const wordsByLine = new Map();
  for (const f of findings) {
    for (const w of f.words || []) {
      if (!wordsByLine.has(w.line)) wordsByLine.set(w.line, new Map());
      wordsByLine.get(w.line).set(w.col, w);
    }
  }
  // Also a pseudo comment written with a line break after it (placePseudos, when the statement has too few lines)
  const isAnnotation = (e) => e.order === ORDER.pragma || e.order === ORDER.pseudo || /"#EC /.test(e.text);
  const removed = new Set();
  const added = [];

  for (const [li, list] of byLine) {
    if (spanned.has(li) || list.some((e) => e.endLine !== li)) continue;
    const line = lines[li] || '';
    // Already too long before the fix: not a line this fix made invalid
    if (line.length > MAX_LINE) continue;
    // The line after its edits, as the lines it becomes (same order as applyEditsToLines)
    const result = (all) => {
      let text = line;
      all.map((e, i) => ({ e, i }))
        .sort((x, y) => y.e.col - x.e.col || (y.e.order || 0) - (x.e.order || 0) || y.i - x.i)
        .forEach(({ e }) => { text = text.slice(0, e.col) + e.text + text.slice(e.endCol); });
      return text.split('\n');
    };
    const longest = (all) => Math.max(...result(all).map((l) => l.length));
    let current = list.slice();
    if (longest(current) <= MAX_LINE) continue;
    const indent = (line.match(/^[ \t]*/) || [''])[0] + '  ';
    const breaks = [];
    const pragma = list.find((e) => e.order === ORDER.pragma && isInsert(e) && !/\n/.test(e.text));
    let pragmaText = null;

    for (let n = 0; n < MAX_BREAKS && longest(current) > MAX_LINE; n++) {
      const options = [];
      // 1. The pragma on a line of its own
      if (pragma && pragmaText === null) {
        const moved = Object.assign({}, pragma, { text: '\n' + indent + pragma.text.replace(/^[ \t]+/, '') });
        options.push({ edits: current.map((e) => (e === pragma ? moved : e)), pragma: moved, rank: 2 });
      }
      // 2. A break before a word (not the first code of the line), where no other edit is
      for (const w of (wordsByLine.get(li) || new Map()).values()) {
        const ws = line.slice(0, w.col).replace(/[ \t]+$/, '').length;
        if (!/\S/.test(line.slice(0, w.col)) || ws === w.col || /^##/.test(w.upper)) continue;
        if (current.some((e) => e.col <= w.col && e.endCol >= ws)) continue;
        const br = { line: li, col: ws, endLine: li, endCol: w.col, text: '\n' + indent, order: ORDER.inline, findings: [] };
        options.push({ edits: current.concat(br), br, rank: BREAK_BEFORE.test(w.upper) ? 1 : 0, col: w.col });
      }
      if (!options.length) break;
      // One that makes every line fit (the pragma first, then a clause keyword, then the latest word); otherwise the one
      // that leaves the shortest longest line, and go on
      options.forEach((o) => { o.max = longest(o.edits); });
      const fitting = options.filter((o) => o.max <= MAX_LINE);
      const pick = (fitting.length ? fitting : options)
        .sort((a, b) => (fitting.length ? 0 : a.max - b.max) || b.rank - a.rank || (b.col || 0) - (a.col || 0))[0];
      if (!fitting.length && pick.max >= longest(current)) break;
      current = pick.edits;
      if (pick.pragma) pragmaText = pick.pragma.text;
      if (pick.br) breaks.push(pick.br);
    }

    if (longest(current) <= MAX_LINE) {
      if (pragmaText !== null) pragma.text = pragmaText;
      added.push(...breaks);
      continue;
    }
    // No break makes room: the fixes that add text to this line are not applied (a rewrite with all of its edits)
    const growing = list.filter((e) => e.text.length > e.endCol - e.col && (e.findings || []).length);
    const gone = [].concat(...growing.map((e) => e.findings)).filter((f, i, all) => all.indexOf(f) === i);
    const rewrites = gone.filter((f) => f.action === 'rewrite');
    for (const e of edits) {
      if (growing.indexOf(e) >= 0 || (e.findings || []).some((f) => rewrites.indexOf(f) >= 0)) removed.add(e);
    }
    unfixable.push({
      findings: gone,
      reason: (growing.some(isAnnotation) ? 'Adding ' + growing.filter(isAnnotation).map((e) => e.text.replace(/\s+/g, ' ').trim()).join(' ') : 'The rewrite') +
        ' would make line ' + (li + 1) + ' longer than ' + MAX_LINE + ' characters, which ABAP rejects, and breaking the line ' +
        'does not make room; shorten the line and run again',
    });
  }
  if (!removed.size && !added.length) return edits;
  return edits.filter((e) => !removed.has(e)).concat(added)
    .sort((a, b) => cmpPos(a.line, a.col, b.line, b.col) || (a.order || 0) - (b.order || 0));
}

/**
 * The rewritten statement, when one rewrite edit replaced all of statement f with a statement starting with the same keyword
 * and ending right before a terminator: a one-line target at the end of the replaced text; otherwise null.
 */
function rewrittenTarget(lines, f, taken) {
  const kw = f.words && f.words[0] ? f.words[0].upper : '';
  const e = taken.find((t) =>
    !isInsert(t) && cmpPos(t.line, t.col, f.startLine, f.startCol) <= 0 && cmpPos(t.endLine, t.endCol, f.endLine, f.endCol) >= 0);
  if (!e || !kw || String(e.text).trim().split(/\s+/)[0].toUpperCase() !== kw || /\n/.test(e.text)) return null;
  const term = (lines[e.endLine] || '').charAt(e.endCol);
  if (term !== '.' && term !== ',') return null;
  return { startLine: e.endLine, startCol: e.endCol, endLine: e.endLine, endCol: e.endCol, terminator: term, chained: false, words: [] };
}

/** Whether the end-of-line comment is already a pseudo comment ("#EC …) */
function isPseudoComment(cm) {
  return !!cm && !cm.fullLine && /^"#EC\b/i.test(cm.text);
}

/** Whether there is more code after col on this line (ignoring the end-of-line comment) */
function codeAfter(lines, comments, li, col) {
  const line = lines[li] || '';
  const cm = comments[li];
  const stop = cm && !cm.fullLine ? cm.col : line.length;
  return /\S/.test(line.slice(col + 1, stop));
}

/**
 * Lines of the statement that can each take one pseudo comment (from the last line upward).
 * A line can hold only one pseudo comment, and it must not also belong to another statement,
 * otherwise the annotation would apply to the other statement.
 */
function pseudoLines(lines, comments, f, allowOccupied) {
  const out = [];
  for (let li = f.endLine; li >= f.startLine; li--) {
    if (f.lastLineOnly && li !== f.endLine) break;
    const cm = comments[li];
    if (cm && cm.fullLine) continue;
    if (!allowOccupied && isPseudoComment(cm)) continue;
    const line = lines[li] || '';
    const code = cm ? line.slice(0, cm.col) : line;
    if (!/\S/.test(code)) continue;
    if (li === f.endLine && (!f.terminator || codeAfter(lines, comments, li, f.endCol))) continue;
    if (li === f.startLine && li !== f.endLine) {
      const pre = line.slice(0, f.startCol);
      // The first part of a chained statement may be preceded by just "DATA:" and similar
      if (/\S/.test(pre) && !(f.chained && /:\s*$/.test(pre) && !/[.,]/.test(pre))) continue;
    }
    out.push(li);
  }
  return out;
}

// When breaking a line, prefer to break before these clause keywords
const BREAK_BEFORE = /^(?:FROM|INTO|APPENDING|WHERE|FIELDS|ORDER|GROUP|HAVING|UP|FOR|INNER|LEFT|RIGHT|JOIN|USING|WITH|BINARY|TRANSPORTING|EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS|AND|OR)$/;

/**
 * Pick n break points (word start positions): breaking before a point gives the part before it its own line for a pseudo comment.
 * Only breaks lines that can take an annotation, preferring clause keywords; returns null when there are not enough break points.
 */
function breakPoints(lines, comments, f, n) {
  const ok = new Set(pseudoLines(lines, comments, f, true));
  const words = (f.words || []).filter((w) => ok.has(w.line) && !/^##/.test(w.upper));
  // The first word of a line cannot be a break point (there is nothing before it to split off)
  const cands = words.filter((w, i) => i > 0 && words[i - 1].line === w.line);
  if (cands.length < n) return null;
  const preferred = cands.filter((w) => BREAK_BEFORE.test(w.upper));
  const rest = cands.filter((w) => !BREAK_BEFORE.test(w.upper));
  // Prefer later keywords: "SELECT * FROM t / INTO TABLE lt" reads better than "SELECT * / FROM t INTO TABLE lt"
  const picked = preferred.length >= n
    ? preferred.slice(preferred.length - n)
    : preferred.concat(rest.slice(rest.length - (n - preferred.length)));
  return picked.sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * Place pseudo comments following the SAP rule "only one pseudo comment per line":
 * one per line of a multi-line statement; when there are not enough lines, break the last line before a clause keyword.
 * When the line already has a regular comment, put "#EC XX right after the " (the existing text stays after it).
 */
function placePseudos(lines, comments, f, names, findings, edits, actions, unfixable) {
  // Lines with room for a pseudo comment within MAX_LINE first (the order stays otherwise: from the last line upward)
  const need = Math.max(...names.map((n) => n.length)) + 6;
  const room = (li) => ((lines[li] || '').length + need <= MAX_LINE ? 1 : 0);
  const avail = pseudoLines(lines, comments, f).sort((a, b) => room(b) - room(a));
  const queue = names.slice();

  // Legacy form "#EC A #EC B: only A is effective, B is placed on another line, so first remove the ineffective B here
  for (let li = f.startLine; li <= f.endLine; li++) {
    const cm = comments[li];
    if (!isPseudoComment(cm)) continue;
    const extra = collectPseudo(cm.text, true).slice(1).filter((n) => names.indexOf(n) >= 0);
    if (!extra.length) continue;
    const re = new RegExp('[ \\t]*#EC[ \\t]+(?:' + extra.join('|') + ')(?!\\w)', 'gi');
    const head = (cm.text.match(/^"#EC[ \t]+[\w*]+/i) || [''])[0];
    const text = head + cm.text.slice(head.length).replace(re, '');
    if (head && text !== cm.text) {
      edits.push({ line: li, col: cm.col, endLine: li, endCol: cm.col + cm.text.length, text, order: ORDER.inline, findings });
    }
  }

  // EXEC SQL … ENDEXEC: the same pseudo comment on an earlier line (EXEC SQL. "#EC CI_EXECSQL) has no effect; it moves to
  // the end, so an end-of-line comment that holds nothing but these pseudo comments is removed
  if (f.lastLineOnly) {
    for (let li = f.startLine; li < f.endLine; li++) {
      const cm = comments[li];
      if (!isPseudoComment(cm) || !/^"(?:[ \t]*#EC[ \t]+[\w*]+)+[ \t]*$/i.test(cm.text)) continue;
      if (!collectPseudo(cm.text, true).every((n) => names.indexOf(n) >= 0)) continue;
      const from = (lines[li] || '').slice(0, cm.col).replace(/[ \t]+$/, '').length;
      edits.push({ line: li, col: from, endLine: li, endCol: cm.col + cm.text.length, text: '', order: ORDER.inline, findings });
    }
  }

  // Not enough lines: the last line has to be broken
  let breaks = [];
  const shortBy = queue.length - avail.length;
  if (shortBy > 0) {
    breaks = breakPoints(lines, comments, f, shortBy) || [];
    if (breaks.length < shortBy) {
      unfixable.push({
        findings,
        reason:
          'Only one pseudo comment is allowed per line; this statement needs ' + queue.length +
          ' (' + queue.map((n) => '"#EC ' + n).join(', ') + ') but there are not enough lines to place them. Split the statement over several lines and run again',
      });
      return;
    }
  }

  const put = (li, name) => {
    const cm = comments[li];
    const lineText = lines[li] || '';
    if (cm && !cm.fullLine) {
      const after = lineText.charAt(cm.col + 1);
      const suffix = after === '' || after === ' ' || after === '\t' ? '' : ' ';
      edits.push(pointEdit(li, cm.col + 1, '#EC ' + name + suffix, ORDER.pseudo, findings));
    } else {
      edits.push(pointEdit(li, lineText.length, ' "#EC ' + name, ORDER.pseudo, findings));
    }
    actions.push({ type: 'pseudo', line: li, text: '"#EC ' + name, findings });
  };

  for (const li of avail) {
    if (!queue.length) break;
    put(li, queue.shift());
  }

  if (breaks.length) {
    // Insert "#EC XX + line break + indent" before each break point: the code before it takes one annotation, the rest moves to the next line
    // (an existing annotation or comment at the end of the original line stays with the last part)
    const indentOf = (li) => ((lines[li] || '').match(/^[ \t]*/) || [''])[0];
    for (const w of breaks) {
      const name = queue.shift();
      if (!name) break;
      const lineText = lines[w.line] || '';
      const indent = indentOf(w.line) + (w.line === f.startLine ? '  ' : '');
      // Pure insert (no characters replaced): the existing space before the break point separates the code from the "
      const before = lineText.charAt(w.col - 1);
      const sep = before === ' ' || before === '\t' ? '' : ' ';
      edits.push(pointEdit(w.line, w.col, sep + '"#EC ' + name + '\n' + indent, ORDER.inline, findings));
      actions.push({ type: 'pseudo', line: w.line, text: '"#EC ' + name + ' (line break)', findings });
    }
  }
}

function pointEdit(line, col, text, order, findings) {
  return { line, col, endLine: line, endCol: col, text, order, findings };
}

/**
 * Sort edits and merge pure inserts at the same position (the editor's order for same-position inserts is undefined),
 * and move edits that still overlap across statements to unfixable (should not happen; a safety net).
 */
function mergeEdits(edits, unfixable) {
  const sorted = edits
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        cmpPos(a.e.line, a.e.col, b.e.line, b.e.col) ||
        (a.e.order || 0) - (b.e.order || 0) ||
        a.i - b.i
    )
    .map((x) => x.e);

  const out = [];
  for (const e of sorted) {
    // The same edit of a rewrite shared by several findings (all parts of a chained statement): applied once
    const same = e.shareKey && out.find((o) => o.shareKey === e.shareKey);
    if (same) {
      same.findings = same.findings.concat(e.findings);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && isInsert(prev) && isInsert(e) && prev.line === e.line && prev.col === e.col) {
      prev.text += e.text;
      prev.findings = prev.findings.concat(e.findings);
      continue;
    }
    if (out.some((o) => overlaps(o, e))) {
      unfixable.push({
        findings: e.findings,
        reason: 'Overlaps with another fix at the same position, which was applied first; run the auto fix again or fix it manually',
      });
      continue;
    }
    out.push(Object.assign({}, e));
  }
  return out;
}

/** Apply edits to an array of lines and return the new lines */
function applyEditsToLines(lines, edits, eol) {
  const nl = eol || '\n';
  const starts = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + nl.length;
  }
  const pos = (line, col) => {
    const li = Math.min(Math.max(line, 0), lines.length - 1);
    return starts[li] + Math.min(col, lines[li].length);
  };

  let text = lines.join(nl);
  const list = edits
    .map((e, i) => ({
      a: pos(e.line, e.col),
      b: pos(e.endLine == null ? e.line : e.endLine, e.endCol == null ? e.col : e.endCol),
      text: String(e.text).replace(/\r\n|\n/g, nl),
      order: e.order || 0,
      i,
    }))
    // Apply from the end backward so earlier offsets stay valid
    .sort((x, y) => y.a - x.a || y.order - x.order || y.i - x.i);

  for (const x of list) text = text.slice(0, x.a) + x.text + text.slice(x.b);
  return text.split(nl);
}

/** Apply edits to plain text (for tests, preview and non-VS Code use) */
function applyEditsToText(text, edits) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\n|\r/);
  return applyEditsToLines(lines, edits, eol).join(eol);
}

module.exports = { planEdits, applyEditsToText };
