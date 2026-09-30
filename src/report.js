'use strict';

const { planEdits } = require('./fixer');

const KIND_LABEL = { pseudo: 'Pseudo Comment', pragma: 'Pragma', rewrite: 'Code rewrite', manual: 'Manual' };

const HOW = {
  pragma: 'Insert before the statement terminator (. or ,)',
  pseudo: 'Append to this line as an end-of-line comment',
  rewrite: 'Rewrite the statement; see "Code rewrite details" below',
};

/** Escape a value for a Markdown table cell: escape | and turn line breaks into <br> */
function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

/** Inline code that stays one code span whatever backticks the text contains */
function mdCode(s) {
  const text = String(s).replace(/\n/g, ' ');
  const tick = '`'.repeat(Math.max(1, ...(text.match(/`+/g) || []).map((b) => b.length + 1)));
  const space = /^`|`$/.test(text) ? ' ' : '';
  return tick + space + text.replace(/\|/g, '\\|') + space + tick;
}

/** A fenced code block longer than any run of backticks in the code, so the code cannot end it */
function mdFence(code, lang) {
  const fence = '`'.repeat(Math.max(3, ...(String(code).match(/`+/g) || []).map((b) => b.length + 1)));
  return fence + (lang || '') + '\n' + code + '\n' + fence;
}

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function numberedSource(lines, fromLine, toLine) {
  const out = [];
  const a = Math.max(0, fromLine);
  const b = Math.min(lines.length - 1, toLine);
  for (let i = a; i <= b; i++) out.push(pad(i + 1, 5) + ' | ' + lines[i]);
  return out.join('\n');
}

/** Turn the result of planEdits into per-line instructions ("line N: do X") */
function instructionLines(plan) {
  const rows = [];
  for (const a of plan.actions) {
    rows.push({
      line: a.line + 1,
      kind: a.type,
      // Use the exact text computed by planEdits so the prompt matches the auto fix result
      tokens: a.text,
      after: a.after,
      rules: a.findings.map((f) => f.ruleId).join(', '),
      how: HOW[a.type],
    });
  }
  for (const u of plan.unfixable) {
    const f0 = u.findings[0];
    let tokens = '';
    if (f0.kind === 'pseudo') tokens = u.findings.map((f) => '"#EC ' + f.tokenName).join(', ');
    else if (f0.kind === 'pragma') tokens = u.findings.map((f) => f.token).join(' ');
    else if (f0.rewrite) tokens = f0.rewrite.summary;
    rows.push({
      line: f0.endLine + 1,
      kind: f0.kind === 'rewrite' ? 'manual' : f0.kind,
      tokens,
      rules: u.findings.map((f) => f.ruleId).join(', '),
      how: '⚠ ' + u.reason,
    });
  }
  rows.sort((a, b) => a.line - b.line);
  return rows;
}

/**
 * Build the Markdown prompt for an AI assistant.
 * @param {Array} files [{ path, text, result }]
 */
function buildAiPrompt(files, options) {
  const opts = options || {};
  const includeSource = opts.includeSource !== false;
  const total = files.reduce((n, f) => n + f.result.findings.length, 0);
  const out = [];

  out.push('# Task: fix SAP ABAP ATC / Code Inspector findings');
  out.push('');
  out.push('Work through the list below line by line: apply the items of type "Code rewrite" as shown, and add the given Pragma / Pseudo Comment for every other item.');
  out.push('');
  out.push('## Hard rules');
  out.push('');
  out.push('1. **Only make the listed changes.** Apart from statements marked "Code rewrite", do not change syntax, order, indentation or variable names.');
  out.push('2. A `##PRAGMA` always goes **before** the statement terminator (`.`, or `,` in a chained statement), for example:');
  out.push('   `DATA lv_x TYPE i ##NEEDED.`');
  out.push('3. A `"#EC XXX` pseudo comment is an end-of-line comment on the line given in the table, for example:');
  out.push('   `READ TABLE lt INTO ls INDEX 1. "#EC CI_SUBRC`');
  out.push('4. **Only one pseudo comment per line** (SAP rule: only the first `#EC` on a line is effective). When a statement needs several, put each one on a different line of the statement, as listed in the table.');
  out.push('   Items marked "(line break)" require breaking the statement at that line so the code before the break keeps that pseudo comment. Several pragmas may share a statement: `##NEEDED ##NO_TEXT`.');
  out.push('5. If the line already has an end-of-line comment, put `#EC XXX` right after the `"` and before the existing comment text.');
  out.push('6. Do not add a pseudo comment or pragma that is already present.');
  out.push('7. A "Code rewrite" must keep the original indentation, line breaks and end-of-line comments; when `SELECT SINGLE` becomes `UP TO 1 ROWS`, always add the matching `ENDSELECT.`.');
  out.push('8. For items of type "Manual" or with ⚠ in the position column, decide yourself whether to rewrite or suppress, and explain what you did at the end of your reply.');
  out.push('');
  out.push('> Note: pseudo comments and pragmas only make ATC skip a check; they do not change runtime behavior. If an item should really be fixed in code rather than suppressed, list your suggestion at the end of your reply, but complete the list first.');
  out.push('');
  out.push('## Items to fix (' + total + ' in total)');
  out.push('');

  for (const f of files) {
    if (!f.result.findings.length) continue;
    const plan = planEdits(f.result.lines, f.result.comments, f.result.findings);
    const rows = instructionLines(plan);

    out.push('### File: ' + mdCode(f.path));
    out.push('');
    out.push('| Line | Type | Annotation / rewrite | Position | Rules |');
    out.push('| ---: | --- | --- | --- | --- |');
    for (const r of rows) {
      const cell = r.tokens ? mdCode(r.tokens) : '';
      out.push('| ' + r.line + ' | ' + KIND_LABEL[r.kind] + ' | ' + cell + ' | ' + mdCell(r.how) + ' | ' + mdCell(r.rules) + ' |');
    }
    out.push('');

    const rewrites = rows.filter((r) => r.kind === 'rewrite');
    if (rewrites.length) {
      out.push('#### Code rewrite details');
      out.push('');
      for (const r of rewrites) {
        out.push('Line ' + r.line + ' (' + r.rules + ') after the rewrite:');
        out.push('');
        out.push(mdFence(r.after, 'abap'));
        out.push('');
      }
    }

    out.push('<details><summary>Rule descriptions</summary>');
    out.push('');
    const seen = new Set();
    for (const fd of f.result.findings) {
      if (seen.has(fd.ruleId)) continue;
      seen.add(fd.ruleId);
      out.push('- **`' + (fd.token || fd.ruleId) + '`** (' + fd.title + '): ' + fd.why);
    }
    out.push('');
    out.push('</details>');
    out.push('');

    if (includeSource) {
      const lines = f.result.lines;
      out.push('#### Source (line numbers are for reference only; do not write them into the file)');
      out.push('');
      out.push(mdFence(numberedSource(lines, 0, lines.length - 1), 'abap'));
      out.push('');
    }
  }

  out.push('## Output format');
  out.push('');
  out.push('Output the complete modified source. If the file is long, output a "line number → new line content" table instead.');
  out.push('');
  return out.join('\n');
}

/** Human-readable Markdown report */
function buildReport(files) {
  const out = [];
  const total = files.reduce((n, f) => n + f.result.findings.length, 0);
  out.push('# SmartFix for ABAP Report');
  out.push('');
  out.push('Generated: ' + new Date().toLocaleString());
  out.push('');
  const count = (a) => files.reduce((n, f) => n + f.result.findings.filter((x) => x.action === a).length, 0);
  out.push(
    'Files: ' + files.length + ' · Findings: **' + total + '**' +
      ' (rewrite ' + count('rewrite') + ', suppress ' + count('suppress') + ', manual ' + count('manual') + ')'
  );
  out.push('');

  const byRule = new Map();
  for (const f of files) {
    for (const fd of f.result.findings) {
      if (!byRule.has(fd.ruleId)) byRule.set(fd.ruleId, { token: fd.token || '(rewrite)', title: fd.title, n: 0 });
      byRule.get(fd.ruleId).n++;
    }
  }
  if (byRule.size) {
    out.push('## Summary');
    out.push('');
    out.push('| Rule | Annotation | Description | Count |');
    out.push('| --- | --- | --- | ---: |');
    const sorted = [...byRule.entries()].sort((a, b) => b[1].n - a[1].n);
    for (const [id, v] of sorted) {
      out.push('| ' + mdCode(id) + ' | ' + mdCode(v.token) + ' | ' + mdCell(v.title) + ' | ' + v.n + ' |');
    }
    out.push('');
  }

  for (const f of files) {
    if (!f.result.findings.length) continue;
    out.push('## ' + mdCode(f.path));
    out.push('');
    out.push('| Line | Fix | Description | Code |');
    out.push('| ---: | --- | --- | --- |');
    for (const fd of f.result.findings) {
      out.push('| ' + (fd.startLine + 1) + ' | ' + mdCell(fd.fixLabel) + ' | ' + mdCell(fd.title) + ' | ' + mdCode(fd.snippet) + ' |');
    }
    out.push('');
  }
  return out.join('\n');
}

module.exports = { buildAiPrompt, buildReport };
