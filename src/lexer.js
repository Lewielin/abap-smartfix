'use strict';

/**
 * Minimal ABAP statement splitter.
 *
 * This is not a full parser. It splits the source into logical statements and records exactly
 * where each statement ends (period / comma), so we know where pragmas and pseudo comments
 * have to go:
 *   - pragma         ##NAME  goes before the statement terminator
 *   - pseudo comment "#EC XX goes after the statement terminator (end-of-line comment)
 *
 * ABAP literals cannot span lines, so the literal state is reset on each line, which keeps this safe.
 */

const RE_PRAGMA_TOKEN = /##[A-Za-z_0-9]+(?:\[[^\]]*\])?/g;
// "#EC * skips all Code Inspector checks for the statement
const RE_PSEUDO_TOKEN = /#EC[ \t]+([A-Za-z_0-9]+|\*)/g;

/**
 * Scan line by line, producing the list of code characters (comments excluded) and each line's end-of-line comment.
 */
function scanSource(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const cells = [];
  const comments = new Array(lines.length).fill(null);
  // String templates: 'tpl' (the text between |…|) and 'emb' (an embedded expression { … } inside it, which is code again and
  // may contain literals and further templates). The whole template counts as one literal. An embedded expression can go on
  // over several lines; template text cannot, so an unclosed one ends with its line.
  let stack = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (stack.length && stack[stack.length - 1] !== 'emb') stack = [];

    // Full-line comment: * in the first column.
    if (line.charAt(0) === '*') {
      comments[li] = { col: 0, text: line, fullLine: true };
      continue;
    }

    let quote = ''; // inside '..' or `..` (never spans lines)
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      const top = stack[stack.length - 1];
      const inTemplate = stack.length > 0;

      if (quote) {
        cells.push({ ch, line: li, col: ci, lit: true });
        if (ch === quote) {
          if (line[ci + 1] === quote) { ci++; cells.push({ ch, line: li, col: ci, lit: true }); }
          else quote = '';
        }
        continue;
      }

      if (top === 'tpl') {
        cells.push({ ch, line: li, col: ci, lit: true });
        if (ch === '\\') {
          ci++;
          if (ci < line.length) cells.push({ ch: line[ci], line: li, col: ci, lit: true });
        } else if (ch === '{') stack.push('emb');
        else if (ch === '|') stack.pop();
        continue;
      }

      // Code, or an embedded expression (code inside a template)
      if (ch === '"') {
        comments[li] = { col: ci, text: line.slice(ci), fullLine: false };
        break;
      }
      if (ch === "'" || ch === '`') { quote = ch; cells.push({ ch, line: li, col: ci, lit: true }); continue; }
      if (ch === '|') { stack.push('tpl'); cells.push({ ch, line: li, col: ci, lit: true }); continue; }
      if (top === 'emb' && ch === '}') stack.pop();
      // The indentation of an embedded expression's next line is layout, not part of the literal
      const indent = inTemplate && isSpace(ch) && !/\S/.test(line.slice(0, ci));
      cells.push({ ch, line: li, col: ci, lit: inTemplate && !indent });
    }

    // A line break counts as whitespace
    cells.push({ ch: ' ', line: li, col: line.length, lit: false });
  }

  return { lines, cells, comments };
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t';
}

/** Trim whitespace cells at both ends */
function trimCells(cells) {
  let a = 0;
  let b = cells.length;
  while (a < b && !cells[a].lit && isSpace(cells[a].ch)) a++;
  while (b > a && !cells[b - 1].lit && isSpace(cells[b - 1].ch)) b--;
  return cells.slice(a, b);
}

/** Join cells into normalized text (runs of whitespace outside literals become one space) */
function cellsToText(cells) {
  let out = '';
  let pendingSpace = false;
  for (const c of cells) {
    if (!c.lit && isSpace(c.ch)) { pendingSpace = out.length > 0; continue; }
    if (pendingSpace) { out += ' '; pendingSpace = false; }
    out += c.ch;
  }
  return out;
}

/** Index of the first top-level symbol among the cells (not in a literal, parenthesis depth 0) */
function findTopLevel(cells, ch) {
  let depth = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.lit) continue;
    if (c.ch === '(') depth++;
    else if (c.ch === ')') depth--;
    else if (depth === 0 && c.ch === ch) return i;
  }
  return -1;
}

/** Split by a top-level symbol; returns [{cells, sepIndexInParent}] */
function splitTopLevel(cells, ch) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.lit) continue;
    if (c.ch === '(') depth++;
    else if (c.ch === ')') depth--;
    else if (depth === 0 && c.ch === ch) {
      parts.push({ cells: cells.slice(start, i), sep: i });
      start = i + 1;
    }
  }
  parts.push({ cells: cells.slice(start), sep: -1 });
  return parts;
}

/**
 * Split cells into words on whitespace outside literals, keeping original positions, so rewrites can make precise local edits.
 * ABAP literals cannot span lines, so each word is always on one line.
 */
function cellsToWords(cells) {
  const words = [];
  let cur = null;
  for (const c of cells) {
    if (!c.lit && isSpace(c.ch)) { cur = null; continue; }
    if (!cur || c.line !== cur.line) {
      cur = { text: '', line: c.line, col: c.col, endCol: c.col };
      words.push(cur);
    }
    cur.text += c.ch;
    cur.endCol = c.col + 1;
  }
  for (const w of words) w.upper = w.text.toUpperCase();
  return words;
}

function collectPragmas(text) {
  const out = [];
  let m;
  RE_PRAGMA_TOKEN.lastIndex = 0;
  while ((m = RE_PRAGMA_TOKEN.exec(text)) !== null) out.push(m[0].toUpperCase());
  return out;
}

/**
 * The effective pseudo comment of an end-of-line comment.
 * SAP allows only one pseudo comment per line ("#EC must directly follow the "),
 * and any later #EC XX on the same line is plain comment text, so only the first is taken.
 * With all = true, every #EC on the line is returned (used by the fixer for cleanup).
 */
function collectPseudo(commentText, all) {
  const out = [];
  if (!commentText) return out;
  if (!all && !/^"#EC\b/i.test(commentText)) return out;
  let m;
  RE_PSEUDO_TOKEN.lastIndex = 0;
  while ((m = RE_PSEUDO_TOKEN.exec(commentText)) !== null) {
    out.push(m[1].toUpperCase());
    if (!all) break;
  }
  return out;
}

/**
 * Split source code into an array of statements.
 * Chained statements (DATA: a, b.) are expanded into several logical statements; text is "leading keyword + that part".
 */
function parse(text) {
  const scan = scanSource(text);
  const { cells, comments, lines } = scan;
  const statements = [];

  const emit = (bodyCells, termCell, chainInfo) => {
    const body = trimCells(bodyCells);
    // An empty part is only a statement when it has a terminator to stand on (DATA: a, . while typing at the end of the file has not)
    if (body.length === 0 && (!chainInfo || !termCell)) return;

    const codeText = chainInfo && chainInfo.head
      ? chainInfo.head + ' ' + cellsToText(body)
      : cellsToText(body);
    if (!codeText.trim()) return;

    const first = body.length ? body[0] : termCell;
    const startLine = first.line;
    const startCol = first.col;
    const endLine = termCell ? termCell.line : body[body.length - 1].line;
    const endCol = termCell ? termCell.col : body[body.length - 1].col + 1;

    const pseudo = [];
    const pseudoAll = [];
    for (let li = startLine; li <= endLine; li++) {
      const cm = comments[li];
      if (cm && !cm.fullLine) {
        pseudo.push(...collectPseudo(cm.text));
        pseudoAll.push(...collectPseudo(cm.text, true));
      }
    }

    statements.push({
      index: statements.length,
      text: codeText,
      upper: codeText.toUpperCase(),
      startLine,
      startCol,
      endLine,
      endCol,
      terminator: termCell ? termCell.ch : '',
      chained: !!(chainInfo && chainInfo.head),
      head: chainInfo ? chainInfo.head : '',
      pragmas: collectPragmas(codeText),
      pseudoComments: pseudo,
      // Includes the second and later (ineffective) #EC on the same line, used when converting obsolete pseudo comments to pragmas
      pseudoAll,
      words: cellsToWords(body),
    });
  };

  const flushRegion = (regionCells, termCell) => {
    const region = trimCells(regionCells);
    if (region.length === 0) return;

    const colonIdx = findTopLevel(region, ':');
    if (colonIdx < 0) {
      emit(region, termCell, null);
      return;
    }

    const head = cellsToText(trimCells(region.slice(0, colonIdx))).trim();
    const rest = region.slice(colonIdx + 1);
    const parts = splitTopLevel(rest, ',');
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const sepCell = isLast ? termCell : rest[parts[i].sep];
      emit(parts[i].cells, sepCell, { head });
    }
  };

  // Native SQL between EXEC SQL. and ENDEXEC. is not ABAP. As for the ABAP compiler, EXEC SQL … ENDEXEC is one statement
  // that ends with the period after ENDEXEC: its pseudo comment goes there (lastLineOnly), not after EXEC SQL. or into the
  // SQL. A period inside the SQL ends nothing, and the SQL text is kept in native (host variables still count as used).
  const finishNative = (st, bodyCells, termCell) => {
    const body = trimCells(bodyCells);
    const all = cellsToText(body);
    if (!/\bENDEXEC\s*$/i.test(all)) return;
    const end = body.slice(-7);
    st.native = all.replace(/\bENDEXEC\s*$/i, '').trim();
    st.words = st.words.concat(cellsToWords(end));
    st.pragmas = st.pragmas.concat(collectPragmas(cellsToText(end)));
    st.endLine = termCell ? termCell.line : end[end.length - 1].line;
    st.endCol = termCell ? termCell.col : end[end.length - 1].col + 1;
    st.terminator = termCell ? termCell.ch : '';
    const cm = comments[st.endLine];
    st.pseudoComments = cm && !cm.fullLine ? collectPseudo(cm.text) : [];
    st.pseudoAll = cm && !cm.fullLine ? collectPseudo(cm.text, true) : [];
    st.lastLineOnly = true;
  };

  let buf = [];
  let inNative = null;
  for (const c of cells) {
    if (!c.lit && c.ch === '.') {
      if (inNative) {
        if (!/\bENDEXEC\s*$/i.test(cellsToText(trimCells(buf)))) {
          buf.push(c);
          continue;
        }
        finishNative(inNative, buf, c);
        inNative = null;
      } else {
        const before = statements.length;
        flushRegion(buf, c);
        const last = statements[statements.length - 1];
        inNative = statements.length > before && !last.chained && /^EXEC\s+SQL(?:\s|$)/.test(last.upper) ? last : null;
      }
      buf = [];
      continue;
    }
    buf.push(c);
  }
  if (trimCells(buf).length) {
    if (inNative) finishNative(inNative, buf, null);
    else flushRegion(buf, null);
  }

  return { lines, comments, statements };
}

module.exports = { parse, collectPseudo };
