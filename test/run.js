'use strict';

/**
 * Analysis engine tests that do not depend on the vscode API.
 * How to run (without Node.js installed, use the Electron bundled with VS Code as node):
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test\run.js
 */

const fs = require('fs');
const path = require('path');
const { analyze: analyzeRaw } = require('../src/analyzer');

// The older tests below run with selectSingleCheck = all (every SELECT SINGLE is listed) to check rewrite and annotation positions;
// the false-positive fixes of the default mode are tested in the "False positives" section near the end of the file.
const analyze = (t, o) => analyzeRaw(t, Object.assign({ selectSingleCheck: 'all' }, o));
const { planEdits, applyEditsToText } = require('../src/fixer');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const file = path.join(__dirname, '..', 'samples', 'demo.abap');
const text = fs.readFileSync(file, 'utf8');
const result = analyze(text, {});

console.log('\n== findings ==');
for (const f of result.findings) {
  console.log(
    String(f.startLine + 1).padStart(4) +
      '  ' +
      f.token.padEnd(20) +
      '  ' +
      f.ruleId.padEnd(22) +
      '  ' +
      f.snippet.slice(0, 60)
  );
}

const at = (line) => result.findings.filter((f) => f.startLine + 1 === line).map((f) => f.ruleId);
const rules = (id) => result.findings.filter((f) => f.ruleId === id).map((f) => f.startLine + 1);

console.log('\n== assertions ==');
check('SELECT * line matches 3 rules', at(28).join() === 'select-no-order-by,select-no-where,subrc-not-checked', JSON.stringify(at(28)));
// SAP: only one pseudo comment per line; in "#EC CI_ALL_FIELDS_NEEDED #EC CI_NOORDER … only the first is effective
check('several #EC on one line: only the first counts, the rest are listed again',
  at(31).join() === 'select-no-where,subrc-not-checked', JSON.stringify(at(31)));
check('SELECT inside a loop is found', rules('select-in-loop').join() === '35', rules('select-in-loop').join());
check('READ TABLE linear search found twice', rules('linear-search').join() === '41,44', rules('linear-search').join());
check('no report when subrc is checked', at(44).indexOf('subrc-not-checked') < 0, JSON.stringify(at(44)));
check('SORT without BY is not reported (no SCI check reports it)', !result.findings.some((f) => f.startLine + 1 === 50));
check('dynamic SQL is found', rules('dynamic-sql').join() === '53', rules('dynamic-sql').join());
check('CLIENT SPECIFIED is found', rules('client-specified').join() === '53', rules('client-specified').join());
check('no CI_NOORDER when ORDER BY is present', at(53).indexOf('select-no-order-by') < 0, JSON.stringify(at(53)));
check('empty CATCH is found', rules('empty-handler').join() === '61', rules('empty-handler').join());
check('BREAK-POINT is found', rules('breakpoint').join() === '65', rules('breakpoint').join());
check('unused variable lv_dummy is found', rules('unused-declaration').join() === '13', rules('unused-declaration').join());
check('declaration with ##NEEDED is skipped', rules('unused-declaration').indexOf(17) < 0);
check('structure components are not reported as unused', rules('unused-declaration').indexOf(7) < 0 && rules('unused-declaration').indexOf(8) < 0);
check('text-literal on by default: CONSTANTS text is found', rules('text-literal').join() === '21', rules('text-literal').join());
check('SELECT SINGLE found twice', rules('select-single').join() === '35,68', rules('select-single').join());
check('default mode rewrites SELECT SINGLE', result.findings.filter((f) => f.ruleId === 'select-single').every((f) => f.action === 'rewrite'));
check('default mode annotates SELECT *, the ORDER BY rewrite (review) is left for manual fixing',
  result.findings.filter((f) => f.startLine + 1 === 28).every((f) => f.action === (f.ruleId === 'select-no-order-by' ? 'manual' : 'suppress')));

// --- applying fixes ---
const plan = planEdits(result.lines, result.comments, result.findings);
const fixed = applyEditsToText(text, plan.edits);
const fixedLines = fixed.split(/\r\n|\n/);

console.log('\n== fixed lines ==');
fixedLines.forEach((l, i) => {
  if (/#EC|##|ENDSELECT|UP TO|^\*\s+BREAK/.test(l) && i > 10) console.log(String(i + 1).padStart(4) + '| ' + l);
});

// The rewrite adds ENDSELECT lines, which shifts later line numbers, so lines are found by content here
const lineOf = (re) => fixedLines.find((l) => re.test(l)) || '';

console.log('\n== fix assertions ==');
check('pragma goes before the period', /##NEEDED,\s*$/.test(fixedLines[12]), fixedLines[12]);
// A one-line SELECT needing 2 pseudo comments is split into 2 lines, one each
const selBlock = fixedLines.slice(27, 29);
check('one pseudo comment per line (single-line statement is broken automatically)',
  selBlock.every((l) => (l.match(/#EC /g) || []).length === 1) &&
  ['CI_NOWHERE', 'CI_SUBRC'].every((n) => selBlock.some((l) => l.indexOf('"#EC ' + n) >= 0)),
  JSON.stringify(selBlock));
check('after breaking, the annotation on the period line follows the period', /\.\s+"#EC /.test(fixedLines[28]), fixedLines[28]);
check('code is unchanged after breaking',
  selBlock.map((l) => l.replace(/"#EC \S+/, '').trim()).join(' ') === 'SELECT * FROM mara INTO TABLE lt_item.',
  JSON.stringify(selBlock));
check('legacy several #EC on one line: ineffective ones move to other lines and are removed from the original',
  (lineOf(/lt_old\./).match(/#EC CI_ALL_FIELDS_NEEDED/) || []).length === 1 &&
  fixedLines.filter((l) => /#EC CI_NOWHERE/.test(l)).length === 2, lineOf(/lt_old\./));
check('##NO_HANDLER goes before the CATCH period', /##NO_HANDLER\.\s*$/.test(lineOf(/CATCH cx_sy_zerodivide/)), lineOf(/CATCH/));
check('existing comment is kept after #EC', /"#EC CI_SUBRC read master data/.test(lineOf(/read master data/)), lineOf(/read master data/));
check('only the ORDER BY rewrite (needs review) is left for manual fixing',
  plan.unfixable.length === 1 && plan.unfixable[0].findings[0].ruleId === 'select-no-order-by' && /needs review/.test(plan.unfixable[0].reason),
  JSON.stringify(plan.unfixable.map((u) => u.reason)));

// UP TO 1 ROWS without ORDER BY is reported itself (SEL_UP_TO), so the rewrite adds "#EC CI_NOORDER on a free line
const ssAt = fixedLines.indexOf('    SELECT matnr FROM mara "#EC CI_NOORDER');
check('multi-line SELECT SINGLE: SINGLE removed, "#EC CI_NOORDER on the free first line', ssAt >= 0);
check('multi-line SELECT SINGLE: UP TO 1 ROWS after the INTO target, pseudo comment moved to this line',
  fixedLines[ssAt + 1] === '      INTO ls_item-matnr UP TO 1 ROWS "#EC CI_SUBRC', fixedLines[ssAt + 1]);
check('multi-line SELECT SINGLE: only one annotation on the period line',
  fixedLines[ssAt + 2] === '      WHERE matnr = ls_item-matnr. "#EC CI_SEL_NESTED', fixedLines[ssAt + 2]);
check('multi-line SELECT SINGLE: ENDSELECT aligned with SELECT', fixedLines[ssAt + 3] === '    ENDSELECT.', fixedLines[ssAt + 3]);
const rmd = fixedLines.indexOf(lineOf(/read master data/));
check('one-line SELECT SINGLE rewritten correctly, broken before WHERE for its second pseudo comment',
  fixedLines[rmd - 1] === '  SELECT matnr FROM mara INTO ls_item-matnr UP TO 1 ROWS "#EC CI_NOORDER' &&
  fixedLines[rmd] === "    WHERE matnr = '1'. \"#EC CI_SUBRC read master data", fixedLines.slice(rmd - 1, rmd + 1).join(' | '));
check('ENDSELECT added after the one-line SELECT SINGLE',
  fixedLines[fixedLines.indexOf(lineOf(/read master data/)) + 1] === '  ENDSELECT.');
check('BREAK-POINT is commented out', lineOf(/BREAK-POINT/) === '*  BREAK-POINT.', lineOf(/BREAK-POINT/));

// Suppress-only mode: never changes code
const onlySuppress = analyze(text, { fixMode: 'suppress' });
const suppressPlan = planEdits(onlySuppress.lines, onlySuppress.comments, onlySuppress.findings);
const suppressFixed = applyEditsToText(text, suppressPlan.edits);
// Suppress only: after removing annotations and whitespace, the code is identical to the original (pseudo comments may only add line breaks)
const codeOnly = (src) => src.replace(/"[^\r\n]*/g, '').replace(/##\w+/g, '').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').trim();
check('suppress mode: code unchanged (only annotations and line breaks)', codeOnly(suppressFixed) === codeOnly(text));
check('suppress mode: SELECT SINGLE gets "#EC CI_NOORDER (AMB_SINGLE of the SELECT without ORDER BY check)',
  onlySuppress.findings.filter((f) => f.ruleId === 'select-single').map((f) => f.action + f.token).join() === 'suppress"#EC CI_NOORDER,suppress"#EC CI_NOORDER');
check('suppress mode: BREAK-POINT gets ##NO_BREAK', /BREAK-POINT ##NO_BREAK./.test(suppressFixed));
const afterSuppress = analyze(suppressFixed, { fixMode: 'suppress' }).findings.map((f) => f.ruleId);
check('suppress mode: only the rewrite-only findings remain after fixing (ORDER BY, CLIENT SPECIFIED → USING CLIENT)',
  afterSuppress.join() === 'select-no-order-by,client-specified-obsolete', afterSuppress.join());

// ruleFixModes can override individual rules
const perRule = analyze(text, { ruleFixModes: { 'select-single': 'suppress', 'select-no-order-by': 'rewrite' } });
check('ruleFixModes: select-single switches to annotation',
  perRule.findings.filter((f) => f.ruleId === 'select-single').every((f) => f.action === 'suppress'));
check('ruleFixModes: select-no-order-by switches to rewrite',
  perRule.findings.find((f) => f.ruleId === 'select-no-order-by' && f.startLine + 1 === 28).action === 'rewrite');
const perRuleFixed = applyEditsToText(text, planEdits(perRule.lines, perRule.comments, perRule.findings).edits);
check('ORDER BY PRIMARY KEY added at the end in classic syntax',
  /lt_item ORDER BY PRIMARY KEY\. "#EC CI_\w+$/m.test(perRuleFixed) &&
  codeOnly(perRuleFixed).indexOf('SELECT * FROM mara INTO TABLE lt_item ORDER BY PRIMARY KEY.') >= 0);

// suppressStyle: switching between the two forms
const asPragma = analyze(text, { suppressStyle: 'pragma', fixMode: 'suppress' });
check('suppressStyle=pragma: CI_SUBRC stays a pseudo comment (the SY-SUBRC check has no pragma)',
  asPragma.findings.filter((f) => f.ruleId === 'subrc-not-checked').every((f) => f.token === '"#EC CI_SUBRC'));
check('suppressStyle=pragma: "#EC NEEDED rules use ##NEEDED',
  asPragma.findings.filter((f) => f.ruleId === 'unused-declaration').every((f) => f.token === '##NEEDED'));
const asPseudo = analyze(text, { suppressStyle: 'pseudo', fixMode: 'suppress' });
check('suppressStyle=pseudo: ##NEEDED becomes "#EC NEEDED',
  asPseudo.findings.filter((f) => f.ruleId === 'unused-declaration').every((f) => f.token === '"#EC NEEDED'));
check('suppressStyle=pseudo: CI_SUBRC without an alternative is unaffected',
  asPseudo.findings.filter((f) => f.ruleId === 'subrc-not-checked').every((f) => f.token === '"#EC CI_SUBRC'));
const pseudoFixed = applyEditsToText(text, planEdits(asPseudo.lines, asPseudo.comments, asPseudo.findings).edits);
check('"#EC NEEDED also counts as annotated',
  analyze(pseudoFixed, { fixMode: 'suppress', suppressStyle: 'pseudo' }).findings.every((f) => /^(?:select-no-order-by|client-specified-obsolete)$/.test(f.ruleId)));
check('with default settings "#EC NEEDED is suggested as ##NEEDED',
  analyze(pseudoFixed, {}).findings.some((f) => f.ruleId === 'obsolete-pseudo-comment' && f.action === 'rewrite'));

// CRLF file: the added ENDSELECT line must use CRLF
const crlfText = text.replace(/\r?\n/g, '\r\n');
const crlf = analyze(crlfText, {});
const crlfFixed = applyEditsToText(crlfText, planEdits(crlf.lines, crlf.comments, crlf.findings).edits);
check('CRLF file has no stray LF', !/[^\r]\n/.test(crlfFixed));

// --- rewrite samples ---
console.log('\n== Auto Fix samples (samples/autofix.abap) ==');
const afText = fs.readFileSync(path.join(__dirname, '..', 'samples', 'autofix.abap'), 'utf8');
// SELECT * field usage has its own tests (test/sci.js); these samples are about rewrite positions
const AF_OPTS = { disabledRules: ['select-star-existence', 'select-star-few-fields'] };
const af = analyze(afText, AF_OPTS);
const afPlan = planEdits(af.lines, af.comments, af.findings);
const afFixed = applyEditsToText(afText, afPlan.edits);
const afLines = afFixed.split(/\r\n|\n/);
const afHas = (line) => afLines.indexOf(line) >= 0;
const afAction = (line, id) => (af.findings.find((f) => f.startLine + 1 === line && f.ruleId === id) || {}).action;

check('new syntax: UP TO 1 ROWS after INTO (end of statement), with "#EC CI_NOORDER',
  afHas('  SELECT matnr FROM mara WHERE matnr = @ls_mara-matnr INTO @DATA(lv_matnr) UP TO 1 ROWS. "#EC CI_NOORDER'));
check('no WHERE: UP TO 1 ROWS at the end, one pseudo comment per line',
  afHas('  SELECT * FROM mara "#EC CI_NOORDER') && afHas('    INTO ls_mara UP TO 1 ROWS. "#EC CI_NOWHERE'));
check('FOR UPDATE is not rewritten, "#EC CI_NOORDER added instead', afAction(34, 'select-single') === 'suppress' &&
  afHas("  SELECT SINGLE FOR UPDATE matnr FROM mara INTO ls_mara-matnr WHERE matnr = '1'. \"#EC CI_NOORDER"));
check('no rewrite when code follows the period, and no room for the pseudo comment: left as is',
  afHas("  SELECT SINGLE matnr FROM mara INTO ls_mara-matnr WHERE matnr = '2'. lv_a = 1."));
check('ENDSELECT count correct (3 rewrites)', afLines.filter((l) => l.trim() === 'ENDSELECT.').length === 3);
check('MOVE → =', afHas("  ls_mara-matnr = 'X'."));
check('ADD → +=', afHas('  lv_cnt += 1.'));
check('SUBTRACT → -=', afHas('  lv_cnt -= lv_a.'));
check('MULTIPLY → *=', afHas('  lv_b *= 2.'));
check('DIVIDE → /=', afHas('  lv_b /= lv_a.'));
check('COMPUTE is removed', afHas('  lv_a = lv_cnt * 2.'));
check('REFRESH without header line → CLEAR itab', afHas('  CLEAR lt_mara.'));
check('REFRESH with header line → CLEAR itab[]', afHas('  CLEAR gt_old[].'));
check('REFRESH inside METHOD → CLEAR itab', afHas('    CLEAR mt_mara.'));
check('DESCRIBE TABLE → lines( )', afHas('  lv_cnt = lines( lt_mara ).'));
check('CALL METHOD → functional call', afHas('  go_obj->run( ).'));
check('MOVE ?TO → ?=', afHas('  go_obj ?= go_any.'));
check('ADD … THEN … UNTIL is not rewritten', afHas('  ADD 1 THEN lv_a UNTIL lv_b GIVING lv_cnt.'));
check('BREAK user is commented out', afHas('*  BREAK developer.'));
check('chained MOVE → one assignment per line', afAction(62, 'obsolete-move') === 'rewrite' &&
  afHas('  lv_cnt = lv_a.') && afHas('  lv_a = lv_cnt.'));
check('MOVE with a comment inside is manual and kept as is',
  afAction(63, 'obsolete-move') === 'manual' && afHas('  MOVE lv_a " source') && afHas('    TO lv_cnt.'));
check('manual items have a reason', afPlan.unfixable.length === 2 && afPlan.unfixable.every((u) => /manually|Only one pseudo comment/.test(u.reason)),
  JSON.stringify(afPlan.unfixable.map((u) => u.reason)));
check('"#EC NEEDED → ##NEEDED (comment removed entirely)', afHas('  DATA lv_keep1 TYPE i ##NEEDED.'));
check('"#EC NEEDED → ##NEEDED (description kept)', afHas('  DATA lv_keep2 TYPE i ##NEEDED. " kept for the interface'));
check('"#EC NOTEXT → ##NO_TEXT', afHas("  WRITE / 'Hello' ##NO_TEXT."));
// As in abap-cleaner: a second #EC on a line is plain text, so it is neither effective nor converted
check('second "#EC WARNOK on a line is ineffective: not converted, SELECT SINGLE is rewritten',
  afHas('  SELECT matnr FROM mara INTO ls_mara-matnr UP TO 1 ROWS "#EC CI_NOORDER') &&
  afHas("    WHERE matnr = '3'. \"#EC CI_SUBRC #EC WARNOK") &&
  afAction(73, 'select-single') === 'rewrite' && !af.findings.some((f) => f.startLine + 1 === 73 && f.ruleId === 'obsolete-pseudo-comment'));
check('no pseudo comment conversion when suppressStyle=pseudo',
  !analyze(afText, { suppressStyle: 'pseudo' }).findings.some((f) => f.ruleId === 'obsolete-pseudo-comment'));

const afSecond = analyze(afFixed, AF_OPTS);
check('only manual items remain after fixing',
  afSecond.findings.length === 2 && planEdits(afSecond.lines, afSecond.comments, afSecond.findings).edits.length === 0,
  afSecond.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join(', '));

// CI_NOORDER is only reported when the result is used in an order-dependent way, so add a BINARY SEARCH here
const orderSrc = afText.replace(
  /(  SELECT \* FROM mara WHERE mtart = 'FERT' INTO TABLE @lt_mara\.\r?\n  CHECK sy-subrc = 0\.)(\r?\n)/,
  "$1$2  READ TABLE lt_mara INTO ls_mara WITH KEY matnr = 'X' BINARY SEARCH.$2"
);
check('(precondition) BINARY SEARCH inserted', orderSrc !== afText);
const afRewrite = analyze(orderSrc, { fixMode: 'rewrite' });
const afRewriteFixed = applyEditsToText(orderSrc, planEdits(afRewrite.lines, afRewrite.comments, afRewrite.findings).edits);
check('rewrite mode: new syntax ORDER BY PRIMARY KEY goes before INTO',
  afRewriteFixed.indexOf("  SELECT * FROM mara WHERE mtart = 'FERT' ORDER BY PRIMARY KEY INTO TABLE @lt_mara.") >= 0);

const afSuppress = analyze(afText, { fixMode: 'suppress' });
check('suppress mode: obsolete syntax rules are manual (no annotation available)',
  afSuppress.findings.filter((f) => /^obsolete-/.test(f.ruleId)).every((f) => f.action === 'manual'));

// Idempotence: running again after fixing must not produce the same findings
const second = analyze(fixed, {});
check(
  'after fixing only the ORDER BY finding (review) remains',
  second.findings.map((f) => f.ruleId).join() === 'select-no-order-by',
  second.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join(', ')
);

// --- false positives (default settings) ---
console.log('\n== String templates ==');
{
  const { parse } = require('../src/lexer');
  const texts = (src) => parse(src).statements.map((s) => s.text);
  check('an embedded expression over two lines: the period ends the statement',
    texts("lv = |Hi { COND string( WHEN a = 1\n  THEN 'x' ELSE 'y' ) }!|.\nWRITE lv.").join('|') ===
      "lv = |Hi { COND string( WHEN a = 1 THEN 'x' ELSE 'y' ) }!||WRITE lv");
  const r = parse("lv = |{ COND #( WHEN a = 1 THEN '}|' ) } x|. WRITE lv. \"#EC NEEDED");
  check('a literal with } and | inside an embedded expression, and the comment after it',
    r.statements.length === 2 && r.statements[1].text === 'WRITE lv' && r.statements[1].pseudoComments.join() === 'NEEDED');
  check('nested templates and escaped braces', texts('a = |x { |y { b }| } z|. c = |\\{ d \\}|.').length === 2);
  check('an unclosed template ends with its line', texts("a = |open\nWRITE b.").length === 1 && texts("a = |open\nb = 1.\nc = 2.").length === 2);
  // While typing at the end of the file
  check('a chained statement ending in a comma at the end of the file does not stop the analysis',
    texts('DATA: a,').join() === 'DATA a' && analyzeRaw('REPORT z.\nMOVE: a TO b,', {}).statements.length === 2);
}

console.log('\n== False positives (samples/false-positive.abap and snippets) ==');
const fpText =fs.readFileSync(path.join(__dirname, '..', 'samples', 'false-positive.abap'), 'utf8');
const fp = analyzeRaw(fpText, {});
const fpList = fp.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join(', ');
// LOOP AT … INTO + MODIFY … FROM the work area is valid, but the SCI check CL_CI_TEST_LOOP_AT reports it (performance)
const fpLine = (re) => fpText.split(/\r?\n/).findIndex((l) => re.test(l)) + 1;
// SELECT … UP TO 10 ROWS without ORDER BY is valid, but ATC reports it (SEL_UP_TO of the SELECT without ORDER BY check)
check('valid code: only the database MODIFY without sy-subrc check, the LOOP … INTO copy and UP TO without ORDER BY remain',
  fpList === fpLine(/LOOP AT gt_mara INTO gs_mara/) + ':loop-modify-from-wa, ' + fpLine(/UP TO 10 ROWS/) + ':select-up-to-no-order-by, ' +
    fpLine(/MODIFY ztab_log/) + ':subrc-not-checked', fpList);

// Snippet tests: rules matched on a given line (1-based; line 1 is REPORT)
const snippet = (body, opts) => {
  const src = ['REPORT ztest.'].concat(body).join('\n');
  const r = analyzeRaw(src, opts || {});
  return (line) => r.findings.filter((f) => f.startLine + 1 === line).map((f) => f.ruleId).sort();
};
const none = (arr) => arr.length === 0;

let at2 = snippet(['SELECT-OPTIONS s_matnr FOR gv_matnr.', 'SELECT-OPTIONS: s_a FOR gv_a, s_b FOR gv_b.', 'SELECTION-SCREEN SKIP 1.']);
check('SELECT-OPTIONS gets no CI_NOORDER / CI_NOWHERE / CI_SUBRC', none(at2(2)), JSON.stringify(at2(2)));
check('chained SELECT-OPTIONS gets none either', none(at2(3)), JSON.stringify(at2(3)));
check('SELECTION-SCREEN gets none', none(at2(4)), JSON.stringify(at2(4)));

at2 = snippet([
  'SELECT-OPTIONS s_matnr FOR gv_matnr.',
  'START-OF-SELECTION.',
  '  SELECT matnr FROM mara INTO CORRESPONDING FIELDS OF TABLE gt WHERE matnr IN s_matnr.',
  '  CHECK sy-subrc = 0.',
  '  SELECT SINGLE mtart FROM mara INTO gv WHERE matnr = gv_matnr.',
  '  CHECK sy-subrc = 0.',
]);
check('SELECT-OPTIONS / INTO CORRESPONDING FIELDS OF TABLE do not put later SELECTs "inside a loop"',
  at2(6).indexOf('select-in-loop') < 0, JSON.stringify(at2(6)));

at2 = snippet([
  'START-OF-SELECTION.',
  '  SELECT matnr FROM mara INTO TABLE gt_a WHERE mtart = gv.',
  '  READ TABLE gt_a INTO gs WITH KEY matnr = gv BINARY SEARCH.',
  '  SELECT matnr FROM mara INTO TABLE gt_b WHERE mtart = gv.',
  '  SORT gt_b BY matnr.',
  '  READ TABLE gt_b INTO gs WITH KEY matnr = gv BINARY SEARCH.',
  '  SELECT matnr FROM mara INTO TABLE gt_c WHERE mtart = gv.',
  '  LOOP AT gt_c INTO gs.',
  '    AT NEW matnr.',
  '    ENDAT.',
  '  ENDLOOP.',
  '  SELECT matnr FROM mara INTO TABLE gt_d WHERE mtart = gv.',
  '  LOOP AT gt_d INTO gs.',
  '  ENDLOOP.',
]);
check('CI_NOORDER: BINARY SEARCH without SORT is reported', at2(3).indexOf('select-no-order-by') >= 0, JSON.stringify(at2(3)));
check('CI_NOORDER: SORT before BINARY SEARCH is not reported', at2(5).indexOf('select-no-order-by') < 0, JSON.stringify(at2(5)));
check('CI_NOORDER: AT NEW inside LOOP is reported', at2(8).indexOf('select-no-order-by') >= 0, JSON.stringify(at2(8)));
check('CI_NOORDER: just reading into a table is not reported', at2(13).indexOf('select-no-order-by') < 0, JSON.stringify(at2(13)));

at2 = snippet([
  'START-OF-SELECTION.',
  '  SELECT SINGLE mtart FROM mara INTO gv WHERE matnr = gv_matnr AND mtart = @<ls>-mtart.',
  '  SELECT SINGLE mtart FROM mara INTO gv WHERE matnr LIKE \'A%\'.',
  '  SELECT SINGLE mtart FROM mara INTO gv WHERE matnr = \'A\' OR matnr = \'B\'.',
  '  SELECT SINGLE mtart FROM mara INTO gv WHERE matnr = lo_obj->mv_matnr.',
  '  SELECT SINGLE mtart FROM mara INTO gv WHERE ersda > gv_date.',
]);
check('SELECT SINGLE with only = conditions: not reported', at2(3).indexOf('select-single') < 0, JSON.stringify(at2(3)));
check('SELECT SINGLE with LIKE: reported', at2(4).indexOf('select-single') >= 0);
check('SELECT SINGLE with OR: reported', at2(5).indexOf('select-single') >= 0);
check('-> in SELECT SINGLE is not taken as >', at2(6).indexOf('select-single') < 0, JSON.stringify(at2(6)));
check('SELECT SINGLE with >: reported', at2(7).indexOf('select-single') >= 0);
check('selectSingleCheck=all: every SELECT SINGLE is reported',
  snippet(['  SELECT SINGLE mtart FROM mara INTO gv WHERE matnr = gv_matnr.'], { selectSingleCheck: 'all' })(2)
    .indexOf('select-single') >= 0);

at2 = snippet([
  'DATA gt_x TYPE STANDARD TABLE OF ztab.',
  'START-OF-SELECTION.',
  '  DELETE FROM ztab WHERE id = 1.',
  '  INSERT ztab FROM gs.',
  '  UPDATE ztab SET flag = \'X\' WHERE id = 1.',
  '  MODIFY ztab FROM TABLE gt_x.',
  '  INSERT INTO ztab VALUES gs.',
  '  DELETE gt_x INDEX 1.',
  '  MODIFY gt_x FROM gs INDEX 1.',
  '  INSERT gs INTO gt_x INDEX 1.',
  '  MODIFY TABLE gt_x FROM gs.',
  '  DELETE TABLE gt_x FROM gs.',
  '  CALL FUNCTION \'Z_FM\' EXPORTING iv = 1.',
  '  CALL TRANSACTION \'MM03\'.',
]);
[4, 5, 6, 7, 8].forEach((l) => check('database operations need a sy-subrc check (line ' + l + ')', at2(l).indexOf('subrc-not-checked') >= 0));
[9, 10, 11, 12, 13].forEach((l) => check('internal table operations get no CI_SUBRC (line ' + l + ')', none(at2(l)), JSON.stringify(at2(l))));
check('CALL FUNCTION without EXCEPTIONS gets no CI_SUBRC', none(at2(14)));
check('CALL TRANSACTION without USING gets no CI_SUBRC', at2(15).indexOf('subrc-not-checked') < 0, JSON.stringify(at2(15)));

at2 = snippet([
  'CLASS lcl DEFINITION.',
  '  PUBLIC SECTION.',
  '    DATA mv_public TYPE i.',
  '  PRIVATE SECTION.',
  '    DATA mv_private TYPE i.',
  'ENDCLASS.',
  'INTERFACE lif.',
  '  DATA mv_intf TYPE i.',
  'ENDINTERFACE.',
]);
check('PUBLIC SECTION attributes get no ##NEEDED', none(at2(4)), JSON.stringify(at2(4)));
check('unused PRIVATE SECTION attributes get ##NEEDED', at2(6).indexOf('unused-declaration') >= 0);
check('interface attributes get no ##NEEDED', none(at2(9)), JSON.stringify(at2(9)));

at2 = snippet([
  'START-OF-SELECTION.',
  '  DO 3 TIMES.',
  '  ENDDO.',
  '  SELECT matnr FROM mara INTO gv UP TO 5 ROWS WHERE mtart = gv_m.',
  '    SELECT SINGLE mtart FROM mara INTO gv2 WHERE matnr = gv.',
  '    CHECK sy-subrc = 0.',
  '  ENDSELECT.',
  '  SELECT COUNT(*) FROM mara WHERE mtart = gv_m.',
  '  SELECT SINGLE mtart FROM mara INTO gv2 WHERE matnr = gv.',
]);
check('SELECT inside SELECT … ENDSELECT gets CI_SEL_NESTED', at2(6).indexOf('select-in-loop') >= 0, JSON.stringify(at2(6)));
check('after ENDSELECT the code is no longer in a loop', at2(10).indexOf('select-in-loop') < 0, JSON.stringify(at2(10)));
check('sy-subrc checked inside the SELECT loop does not count; unchecked after ENDSELECT is reported', at2(5).indexOf('subrc-not-checked') >= 0, JSON.stringify(at2(5)));
check('SELECT COUNT(*) is not a loop, so the next SELECT is not in a loop', at2(10).indexOf('select-in-loop') < 0);

// --- ##NEEDED: global variables used from other files ---
at2 = snippet([
  'DATA: answer TYPE c.',
  'START-OF-SELECTION.',
  "  CALL FUNCTION 'POPUP_TO_CONFIRM' EXPORTING text_question = 'Continue?'(001) IMPORTING answer = answer EXCEPTIONS OTHERS = 1.",
  "  IF sy-subrc <> 0 OR answer <> '1'.",
  '  ENDIF.',
]);
check('used global variables get no ##NEEDED', at2(2).indexOf('unused-declaration') < 0, JSON.stringify(at2(2)));
const topInc = analyzeRaw('*& Include ZPROG_TOP\nDATA: answer TYPE c,\n      gv_flag TYPE c.\n', {});
check('global declarations of a TOP include (no REPORT) get no ##NEEDED', topInc.findings.length === 0,
  topInc.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join());
const withInc = analyzeRaw('REPORT zprog.\nINCLUDE zprog_top.\nDATA gv_x TYPE i.\nFORM f.\n  DATA lv_x TYPE i.\nENDFORM.\n', {});
check('main program with INCLUDE: no global findings, local ones inside FORM still reported',
  withInc.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join() === '5:unused-declaration',
  withInc.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join());
const withScreen = analyzeRaw('REPORT zprog.\nDATA ok_code TYPE sy-ucomm.\nSTART-OF-SELECTION.\n  CALL SCREEN 100.\n', {});
check('with CALL SCREEN (dynpro fields) global declarations get no ##NEEDED', withScreen.findings.length === 0);

// --- ##NO_TEXT ---
at2 = snippet([
  'START-OF-SELECTION.',
  "  wa_fieldcatalog-reptext_ddic     = 'Created On'.",
  "  wa_fieldcatalog-fieldname        = 'ERDAT'.",
  "  wa_fieldcatalog-seltext_m        = 'Usage'(002).",
  "  lv_text = TEXT-003.",
  "  lv_msg = |Total { lv_cnt } rows|.",
  "  lv_msg = |{ lv_cnt }|.",
  "  MESSAGE 'No data found' TYPE 'S'.",
  "  SELECT matnr FROM mara INTO TABLE lt WHERE mtart = 'Fert'.",
  "  SET PF-STATUS 'Main'.",
  "  lv_flag = 'X'.",
  "  lv_str = `Plant name`.",
  "  lv_cn = '物料'.",
]);
check('ALV column heading gets ##NO_TEXT', at2(3).indexOf('text-literal') >= 0, JSON.stringify(at2(3)));
check('all-uppercase technical names are skipped', at2(4).indexOf('text-literal') < 0);
check("text linked to a text symbol 'x'(002) is skipped", at2(5).indexOf('text-literal') < 0);
check('TEXT-003 is skipped', at2(6).indexOf('text-literal') < 0);
check('text in a string template gets ##NO_TEXT', at2(7).indexOf('text-literal') >= 0);
check('string template with only expressions is skipped', at2(8).indexOf('text-literal') < 0);
check('MESSAGE text gets ##NO_TEXT', at2(9).indexOf('text-literal') >= 0);
check('SQL condition values are skipped', at2(10).indexOf('text-literal') < 0);
check('SET PF-STATUS is skipped', at2(11).indexOf('text-literal') < 0);
check("single character 'X' is skipped", at2(12).indexOf('text-literal') < 0);
check('backquote string gets ##NO_TEXT', at2(13).indexOf('text-literal') >= 0);
check('CJK text gets ##NO_TEXT', at2(14).indexOf('text-literal') >= 0);
const ntSrc = "REPORT z.\nSTART-OF-SELECTION.\n  wa_fieldcatalog-reptext_ddic     = 'Created On'.\n  WRITE: / 'Hello', 'World'(001).\n";
const nt = analyzeRaw(ntSrc, {});
const ntFixed = applyEditsToText(ntSrc, planEdits(nt.lines, nt.comments, nt.findings).edits).split('\n');
check('##NO_TEXT goes before the period', ntFixed[2] === "  wa_fieldcatalog-reptext_ddic     = 'Created On' ##NO_TEXT.", ntFixed[2]);
check('chained statement: only the part that needs it is annotated', ntFixed[3] === "  WRITE: / 'Hello' ##NO_TEXT, 'World'(001).", ntFixed[3]);

// --- pseudo comments: one per line ---
const pcSrc = 'REPORT z.\nSTART-OF-SELECTION.\n  SELECT * FROM t001 INTO TABLE @DATA(lt). " company codes\n';
const pc = analyzeRaw(pcSrc, {});
const pcFixed = applyEditsToText(pcSrc, planEdits(pc.lines, pc.comments, pc.findings).edits).split('\n');
check('2 pseudo comments split over 2 lines, existing comment kept on the last line',
  pcFixed.slice(2, 4).every((l) => (l.match(/#EC /g) || []).length === 1) && /\. "#EC CI_\w+ company codes$/.test(pcFixed[3]),
  JSON.stringify(pcFixed.slice(2, 4)));
check('0 findings after splitting', analyzeRaw(pcFixed.join('\n'), {}).findings.length === 0);
const pcTight = 'REPORT z.\nSTART-OF-SELECTION.\n  SELECT * FROM t001 INTO TABLE @DATA(lt). lv_a = 1.\n';
const pcT = analyzeRaw(pcTight, {});
check('code after the period: pseudo comment cannot be placed, listed as manual',
  planEdits(pcT.lines, pcT.comments, pcT.findings).unfixable.length > 0);

// --- MOVE EXACT / GET REFERENCE / CALL METHOD / CREATE OBJECT rewrites ---
const qfSrc = [
  'REPORT z.',
  'START-OF-SELECTION.',
  '  CALL METHOD go_obj->run EXPORTING iv_a = lv_a.',
  '  CALL METHOD go_obj->calc',
  '    EXPORTING',
  '      iv_a = lv_a',
  '    IMPORTING',
  '      ev_b = lv_b.',
  '  CALL METHOD (lv_name).',
  '  CREATE OBJECT go_obj.',
  '  CREATE OBJECT go_obj EXPORTING iv_a = lv_a.',
  '  CREATE OBJECT go_obj TYPE zcl_y',
  '    EXPORTING',
  '      iv_a = lv_a.',
  '  CREATE OBJECT go_obj EXCEPTIONS OTHERS = 1.',
  '  GET REFERENCE OF lv_a INTO lr_ref.',
  '  MOVE EXACT lv_b TO lv_a.',
].join('\n');
const qf = analyzeRaw(qfSrc, {});
const qfLines = applyEditsToText(qfSrc, planEdits(qf.lines, qf.comments, qf.findings).edits).split('\n');
const qfHas = (l) => qfLines.indexOf(l) >= 0;
check('CALL METHOD with only EXPORTING → keyword omitted', qfHas('  go_obj->run( iv_a = lv_a ).'));
check('CALL METHOD with several parameter sections → layout kept',
  qfHas('  go_obj->calc(') && qfHas('    EXPORTING') && qfHas('      ev_b = lv_b ).'));
check('dynamic CALL METHOD is neither listed nor rewritten', qfHas('  CALL METHOD (lv_name).') && !qf.findings.some((f) => f.startLine === 8));
check('CREATE OBJECT → NEW #( )', qfHas('  go_obj = NEW #( ).'));
check('CREATE OBJECT EXPORTING → NEW #( params )', qfHas('  go_obj = NEW #( iv_a = lv_a ).'));
check('CREATE OBJECT TYPE → NEW cls(, EXPORTING line removed',
  qfHas('  go_obj = NEW zcl_y(') && qfHas('      iv_a = lv_a ).') && qfLines.every((l) => l.trim() !== ''));
check('CREATE OBJECT with EXCEPTIONS is not rewritten', qfHas('  CREATE OBJECT go_obj EXCEPTIONS OTHERS = 1.'));
check('GET REFERENCE → REF #( )', qfHas('  lr_ref = REF #( lv_a ).'));
check('MOVE EXACT → EXACT #( )', qfHas('  lv_a = EXACT #( lv_b ).'));

// --- custom rules ---
console.log('\n== Custom rules ==');
const customSrc = [
  'REPORT ztest.',
  'START-OF-SELECTION.',
  '  COMMIT WORK.',
  '  COMMIT WORK. "#EC CI_COMMIT',
  '  WAIT UP TO 1 SECONDS.',
  '  WAIT FOR ASYNCHRONOUS TASKS UNTIL gv_done = abap_true.',
].join('\n');
const customRules = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.abap-smartfix-rules.example.json'), 'utf8')
).map((r) => Object.assign({}, r, { enabled: true }))
  .concat([{ id: 'wait', token: '##ZZ_WAIT_OK', title: 'WAIT', match: '^WAIT\\b', notMatch: '\\bUNTIL\\b' }]);
const custom = analyze(customSrc, { customRules: customRules });
const customLines = custom.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join(', ');
check('custom rules take effect', custom.findings.length === 2, customLines);
check('annotated line is skipped', custom.findings.every((f) => f.startLine + 1 !== 4), customLines);
check('notMatch works (WAIT … UNTIL does not trigger)', customLines.indexOf('6:wait') < 0 && customLines.indexOf('5:wait') >= 0, customLines);
const customPlan = planEdits(custom.lines, custom.comments, custom.findings);
const customFixed = applyEditsToText(customSrc, customPlan.edits).split('\n');
check('custom pseudo comment placed correctly', /COMMIT WORK\. "#EC CI_COMMIT/.test(customFixed[2]), customFixed[2]);
check('custom pragma placed correctly', /WAIT UP TO 1 SECONDS ##ZZ_WAIT_OK\./.test(customFixed[4]), customFixed[4]);

const replaceRules = [
  {
    id: 'write-to-output',
    title: 'WRITE → cl_demo_output',
    match: '^WRITE\\s+(\\S+)$',
    replace: 'cl_demo_output=>write( $1 )',
  },
];
const replaceSrc = ['REPORT ztest.', 'START-OF-SELECTION.', '  WRITE lv_text.', '  WRITE: lv_text.'].join('\n');
const replaced = analyze(replaceSrc, { customRules: replaceRules });
const replacedFixed = applyEditsToText(
  replaceSrc,
  planEdits(replaced.lines, replaced.comments, replaced.findings).edits
).split('\n');
check('custom rewrite rule (replace) takes effect', replacedFixed[2] === '  cl_demo_output=>write( lv_text ).', replacedFixed[2]);
check('custom rewrite rule leaves chained statements alone', replacedFixed[3] === '  WRITE: lv_text.', replacedFixed[3]);
check('chained statement listed as manual', replaced.findings.some((f) => f.startLine === 3 && f.action === 'manual'));
// flags g / y would make RegExp.test alternate between hits and misses on consecutive statements
const gFlag = analyze(['REPORT ztest.', 'COMMIT WORK.', 'COMMIT WORK.', 'COMMIT WORK.'].join('\n'),
  { customRules: [{ id: 'commit', match: '^COMMIT', flags: 'gy', token: '"#EC CI_COMMIT' }] });
check('custom rule flags g / y: every statement is found', gFlag.findings.filter((f) => f.ruleId === 'commit').length === 3);

// Chained MOVE: rewritten only when the whole chain can be replaced
const chainFix = (lines) => {
  const src = ['REPORT ztest.'].concat(lines).join('\n');
  const r = analyze(src, {});
  return applyEditsToText(src, planEdits(r.lines, r.comments, r.findings.filter((f) => f.ruleId === 'obsolete-move')).edits)
    .split('\n').slice(1);
};
check('chained MOVE over several lines → one assignment per line, the comment after the period kept',
  chainFix(['  MOVE: a TO b,', '        c TO d. " copy']).join('|') === '  b = a.|  d = c. " copy');
check('chained MOVE with a comment inside is not rewritten',
  chainFix(['  MOVE: a TO b, " first', '        c TO d.']).join('|') === '  MOVE: a TO b, " first|        c TO d.');
check('chained MOVE with other code in front of MOVE is not rewritten',
  chainFix(['  x = 1. MOVE: a TO b, c TO d.']).join('|') === '  x = 1. MOVE: a TO b, c TO d.');
check('MOVE a TO: b, c (colon after TO) is not rewritten', chainFix(['  MOVE a TO: b, c.']).join('|') === '  MOVE a TO: b, c.');

// --- behavior aligned with SAP/abap-cleaner ---
console.log('\n== Aligned with abap-cleaner ==');
// Fix a METHOD body with the default settings and return the fixed lines of the body
const cleanFix = (body, opts) => {
  const src = ['CLASS lcl DEFINITION.', '  PUBLIC SECTION.', '    METHODS m.', 'ENDCLASS.', 'CLASS lcl IMPLEMENTATION.', '  METHOD m.']
    .concat(body, ['  ENDMETHOD.', 'ENDCLASS.']).join('\n');
  const r = analyzeRaw(src, opts || {});
  const out = applyEditsToText(src, planEdits(r.lines, r.comments, r.findings).edits).split('\n');
  return { lines: out.slice(6, out.length - 2), findings: r.findings };
};
const cf = (body, opts) => cleanFix(body, opts).lines;

check('MOVE ?TO → ?=', cf(['    MOVE lo_source ?TO lo_dest.'])[0] === '    lo_dest ?= lo_source.');
check('MOVE EXACT → EXACT #( )', cf(['    MOVE EXACT iv_a TO ev_b.'])[0] === '    ev_b = EXACT #( iv_a ).');
check('MOVE with a functional call as the source',
  cf(['    MOVE get_date( iv_year = iv_year ) TO ev_date.'])[0] === '    ev_date = get_date( iv_year = iv_year ).',
  cf(['    MOVE get_date( iv_year = iv_year ) TO ev_date.'])[0]);
check('MOVE with an offset target', cf(["    MOVE '12' TO ev_start+4(2)."])[0] === "    ev_start+4(2) = '12'.");
check('ADD … TO → +=', cf(['    ADD 1 TO ls_struc-component.'])[0] === '    ls_struc-component += 1.');
check('SUBTRACT a negative number → -= -1', cf(['    SUBTRACT -1 FROM lv_a.'])[0] === '    lv_a -= -1.');
check('MULTIPLY by an expression → *= expression', cf(['    MULTIPLY lv_a BY lv_b + 1.'])[0] === '    lv_a *= lv_b + 1.');
check('release 7.50: ADD → a = a + b', cf(['    ADD iv_value TO lv_length.'], { abapRelease: '7.50' })[0] === '    lv_length = lv_length + iv_value.');
check('release 7.50: MULTIPLY by an expression keeps its meaning with parentheses',
  cf(['    MULTIPLY lv_a BY lv_b + 1.'], { abapRelease: '7.50' })[0] === '    lv_a = lv_a * ( lv_b + 1 ).',
  cf(['    MULTIPLY lv_a BY lv_b + 1.'], { abapRelease: '7.50' })[0]);
check('DESCRIBE TABLE is not replaced when SY-TFILL is evaluated',
  !cleanFix(['    DESCRIBE TABLE lt_a LINES lv_n.', '    lv_x = sy-tfill.']).findings.some((f) => f.ruleId === 'obsolete-describe-lines'));
check('DESCRIBE TABLE … LINES DATA( ) → DATA( ) = lines( )',
  cf(['    DESCRIBE TABLE lt_a LINES DATA(lv_n).'])[0] === '    DATA(lv_n) = lines( lt_a ).');
check('CREATE OBJECT is not rewritten when the target is read in its parameters',
  !cleanFix(['    CREATE OBJECT mo_target', '      EXPORTING iv_value = mo_target->gc_static_value.'])
    .findings.some((f) => f.ruleId === 'obsolete-create-object'));
check('CREATE OBJECT with a formal parameter named like the target is still rewritten',
  cf(['    CREATE OBJECT lo EXPORTING lo = 1.'])[0] === '    lo = NEW #( lo = 1 ).', cf(['    CREATE OBJECT lo EXPORTING lo = 1.'])[0]);
check('CALL METHOD … RECEIVING → x = m( … )',
  cf(['    CALL METHOD other_method EXPORTING iv_name = iv_name RECEIVING rv_result = DATA(lv_result).'])[0] ===
    '    DATA(lv_result) = other_method( iv_name = iv_name ).',
  cf(['    CALL METHOD other_method EXPORTING iv_name = iv_name RECEIVING rv_result = DATA(lv_result).'])[0]);
check('CALL METHOD … RECEIVING without parameters → x = m( )',
  cf(['    CALL METHOD lo->get RECEIVING rv = lv_x.'])[0] === '    lv_x = lo->get( ).', cf(['    CALL METHOD lo->get RECEIVING rv = lv_x.'])[0]);
check('multi-line CALL METHOD … RECEIVING keeps the parameter layout',
  cf(['    CALL METHOD other_method', '      EXPORTING iv_a = 1', '                iv_b = 2', '      RECEIVING rv = lv_x.']).join('|') ===
    '    lv_x = other_method(|      iv_a = 1|                iv_b = 2 ).',
  cf(['    CALL METHOD other_method', '      EXPORTING iv_a = 1', '                iv_b = 2', '      RECEIVING rv = lv_x.']).join('|'));

check('"#EC NOBREAK → ##NO_BREAK (SLIN_DESC table)', cf(['    WRITE / lv_a. "#EC NOBREAK'])[0] === '    WRITE / lv_a ##NO_BREAK.');
check('"#EC ARGCHECKED → ##ARG_OK', cf(['    WRITE / lv_a. "#EC ARGCHECKED'])[0] === '    WRITE / lv_a ##ARG_OK.');
check('pseudo comment code in lower case is not converted', cf(['    WRITE / lv_a. "#EC argchecked'])[0] === '    WRITE / lv_a. "#EC argchecked');
check('text after the pseudo comment stays as a comment',
  cf(['    TRY.', '        lv_a = 1 / lv_b.', '      CATCH cx_sy_zerodivide. "#EC NO_HANDLER nothing to do', '    ENDTRY.'])[2] ===
    '      CATCH cx_sy_zerodivide ##NO_HANDLER. " nothing to do');
check('pseudo comment right after a chain colon is not converted',
  cf(['    DATA: "#EC NEEDED', '      lv_a TYPE i,', '      lv_b TYPE i.', '    lv_a = lv_b.'])[0] === '    DATA: "#EC NEEDED');
check('" #EC … (space after the ") is not a pseudo comment',
  cleanFix(['    DATA lv_z TYPE i. " #EC NEEDED']).findings.some((f) => f.ruleId === 'unused-declaration'));

const unusedOpts = { fixMode: 'rewrite' };
check('unused local variable is deleted', cf(['    DATA lv_unused TYPE i.', '    WRITE / 1.'], unusedOpts).join('|') === '    WRITE / 1.',
  cf(['    DATA lv_unused TYPE i.', '    WRITE / 1.'], unusedOpts).join('|'));
check('unused local constant is commented out',
  cf(['    CONSTANTS lc_unused TYPE i VALUE 1.', '    WRITE / 1.'], unusedOpts)[0] === '*    CONSTANTS lc_unused TYPE i VALUE 1.');
check('variable only used in commented-out code is commented out',
  cf(['    DATA lv_old TYPE i.', '*    lv_old = 1.', '    WRITE / 1.'], unusedOpts)[0] === '*    DATA lv_old TYPE i.');
check('variable only filled by MESSAGE … INTO gets ##NEEDED',
  cf(['    DATA lv_msg TYPE string.', '    MESSAGE e001(zz) INTO lv_msg.'], unusedOpts)[0] === '    DATA lv_msg TYPE string ##NEEDED.');
check('MESSAGE … INTO DATA( ) that is never read gets ##NEEDED',
  cf(['    MESSAGE e001(zz) INTO DATA(lv_msg).'])[0] === '    MESSAGE e001(zz) INTO DATA(lv_msg) ##NEEDED.');
check('variable that is read after MESSAGE … INTO is not reported',
  !cleanFix(['    DATA lv_msg TYPE string.', '    MESSAGE e001(zz) INTO lv_msg.', '    WRITE / lv_msg.']).findings.some((f) => f.ruleId === 'unused-declaration'));

// itab[] already names the table body: never CLEAR itab[][] / lines( itab[][] )
const bodySrc = ['REPORT z.', 'DATA: it_trdir TYPE TABLE OF trdir WITH HEADER LINE,', '      lt_x TYPE TABLE OF trdir,', '      n TYPE i.',
  'REFRESH : it_trdir[].', 'REFRESH it_trdir[].', 'REFRESH : it_trdir[], lt_x.', 'DESCRIBE TABLE it_trdir[] LINES n.', ''].join('\n');
const bodyRes = analyzeRaw(bodySrc, {});
const bodyOut = applyEditsToText(bodySrc, planEdits(bodyRes.lines, bodyRes.comments, bodyRes.findings).edits).split('\n');
check('chained REFRESH : itab[] → CLEAR : itab[]', bodyOut[4] === 'CLEAR : it_trdir[].', bodyOut[4]);
check('REFRESH itab[] → CLEAR itab[]', bodyOut[5] === 'CLEAR it_trdir[].', bodyOut[5]);
check('chained REFRESH with itab[] and a table without header line', bodyOut[6] === 'CLEAR : it_trdir[], lt_x.', bodyOut[6]);
check('DESCRIBE TABLE itab[] → lines( itab[] )', bodyOut[7] === 'n = lines( it_trdir[] ).', bodyOut[7]);

// SELECT * into one shared work area as an existence check, the work area only used for typing
const exSrc = ['REPORT z.', 'DATA: ls_dd02l TYPE dd02l.', 'SELECT-OPTIONS p_tables FOR ls_dd02l-tabname.', 'START-OF-SELECTION.',
  "SELECT SINGLE * FROM dd02l INTO ls_dd02l WHERE tabname = 'T001' AND tabclass <> 'VIEW'.", "IF sy-subrc = 0. WRITE 'x'. ENDIF.",
  "SELECT SINGLE * FROM dd02l INTO ls_dd02l WHERE tabname = 'T000' AND tabclass <> 'VIEW'.", "IF sy-subrc = 0. WRITE 'y'. ENDIF.", ''].join('\n');
const exLines = analyzeRaw(exSrc, {}).findings.filter((f) => f.ruleId === 'select-star-existence').map((f) => f.startLine + 1);
check('SELECT * existence check: SELECT-OPTIONS FOR wa-field and another SELECT INTO wa read no field', exLines.join() === '5,7', exLines.join());
check('a field read from the work area still counts',
  !analyzeRaw(exSrc + "WRITE ls_dd02l-tabclass.\n", {}).findings.some((f) => f.ruleId === 'select-star-existence'));

// DELETE itab WHERE line IS INITIAL after CALL FUNCTION does not evaluate its sy-subrc
const fmSrc = ['REPORT z.', 'START-OF-SELECTION.', "  CALL FUNCTION 'LIST_TO_ASCI' TABLES listasci = list_asci EXCEPTIONS empty_list = 1 OTHERS = 2.",
  "  DELETE list_asci WHERE line CP '---*' OR line IS INITIAL.", ''].join('\n');
check('IS INITIAL inside DELETE … WHERE is not a sy-subrc check', analyzeRaw(fmSrc, {}).findings.some((f) => f.ruleId === 'fm-subrc-not-checked'));
check('IF itab IS INITIAL after the call still counts as a check',
  !analyzeRaw(fmSrc.replace(/  DELETE[^\n]*/, '  IF list_asci IS INITIAL. RETURN. ENDIF.'), {}).findings.some((f) => f.ruleId === 'fm-subrc-not-checked'));

// Finding keys: the sidebar remembers unchecked findings by key, so a key must survive lines inserted above
const keysA = analyzeRaw('REPORT z.\nSELECT * FROM mara INTO TABLE @DATA(lt).\n', {}).findings.map((f) => f.key);
const keysB = analyzeRaw('REPORT z.\n" new comment\n\nSELECT * FROM mara INTO TABLE @DATA(lt).\n', {}).findings.map((f) => f.key);
check('finding keys survive lines inserted above', keysA.length > 0 && keysA.join() === keysB.join());
const keysDup = analyzeRaw('REPORT z.\nSELECT * FROM mara INTO TABLE @DATA(lt).\nSELECT * FROM mara INTO TABLE @DATA(lt).\n', {}).findings.map((f) => f.key);
check('finding keys are unique for identical statements', new Set(keysDup).size === keysDup.length);

console.log('\n== Lines stay within 255 characters (ABAP rejects longer ones) ==');
{
  const fixLong = (src) => {
    const r = analyzeRaw(src, {});
    const plan = planEdits(r.lines, r.comments, r.findings);
    return { plan, out: applyEditsToText(src, plan.edits) };
  };
  const within = (text) => text.split('\n').every((l) => l.length <= 255);
  const lit = (ch, n) => "'" + ch.repeat(n) + "'";
  const tbl = 'DATA lt TYPE STANDARD TABLE OF zsf_demo_material.';

  const prSrc = ['REPORT z.', 'FORM f.', '  DATA lv_unused TYPE string VALUE ' + lit('x', 212) + '.', 'ENDFORM.', ''].join('\n');
  const pr = fixLong(prSrc);
  const prLines = pr.out.split('\n');
  check('pragma that would pass 255 characters: on a line of its own, with the period',
    prSrc.split('\n')[2].length <= 255 && within(pr.out) && prLines[2] === prSrc.split('\n')[2].slice(0, -1) &&
    /^ {4}##\w+(?: ##\w+)*\.$/.test(prLines[3]) && !analyzeRaw(pr.out, {}).findings.length, prLines.slice(2, 4).join(' | '));

  const psSrc = ['REPORT z.', tbl, '  SELECT * FROM zsf_demo_material INTO TABLE lt WHERE matnr = ' + lit('A', 75) +
    ' AND mtart = ' + lit('B', 75) + ' ORDER BY PRIMARY KEY.', ''].join('\n');
  const ps = fixLong(psSrc);
  const psLines = ps.out.split('\n');
  check('pseudo comment that would pass 255 characters: the statement is broken before a clause keyword',
    psSrc.split('\n')[2].length <= 255 && within(ps.out) && psLines[3] === '    ORDER BY PRIMARY KEY. "#EC CI_SUBRC' &&
    !analyzeRaw(ps.out, {}).findings.length, psLines.slice(2, 4).map((l) => l.length + ':' + l.slice(-40)).join(' | '));

  const cmSrc = ['REPORT z.', tbl, '  SELECT * FROM zsf_demo_material INTO TABLE lt WHERE matnr = ' + lit('A', 55) +
    ' AND mtart = ' + lit('B', 55) + ' ORDER BY PRIMARY KEY. " read all materials of the type', ''].join('\n');
  const cm = fixLong(cmSrc);
  check('pseudo comment added to an existing comment: the line is broken too, the comment stays',
    within(cm.out) && /^ {4}ORDER BY PRIMARY KEY\. "#EC CI_SUBRC read all materials of the type$/.test(cm.out.split('\n')[3]), cm.out);

  // Even after a break before WORK, WORK. and the comment with "#EC CI_ROLLBACK would not fit on one line
  const nbSrc = ['REPORT z.', 'ROLLBACK WORK. " ' + 'c'.repeat(236), ''].join('\n');
  const nb = fixLong(nbSrc);
  check('no break makes room: the line is left as it is and the finding is left for a manual fix, with the reason',
    nbSrc.split('\n')[1].length <= 255 && nb.out === nbSrc &&
    nb.plan.unfixable.some((u) => /longer than 255/.test(u.reason) && u.findings.some((f) => f.ruleId === 'critical-rollback')),
    JSON.stringify(nb.plan.unfixable.map((u) => u.reason)));
}

console.log('\n== Security: settings and rule files cannot write code ==');
const { validToken } = require('../src/rules');
check('plain annotations are valid tokens', ['##NEEDED', '##SHADOW[FOO]', '"#EC CI_SUBRC', '"#EC *'].every(validToken));
check('anything else is not', ['##NEEDED.\nDELETE FROM mara', '"#EC CI_SUBRC\nWRITE x', 'DELETE FROM mara', '##A[x].', ''].every((t) => !validToken(t)));
const injSrc = "REPORT z.\nSELECT * FROM mara INTO TABLE @DATA(lt).\n";
const inj = analyze(injSrc, { tokenOverrides: { 'select-no-where': '##X.\n  DELETE FROM mara' } });
const injFixed = applyEditsToText(injSrc, planEdits(inj.lines, inj.comments, inj.findings).edits);
check('tokenOverrides with code in it is ignored (the rule annotation is used)', !/DELETE/.test(injFixed) && /"#EC CI_NOWHERE/.test(injFixed), injFixed);
const injRule = analyze(injSrc, { customRules: [{ id: 'x', match: 'SELECT', token: '##X.\nDELETE FROM mara' }] });
check('a custom rule whose token is not an annotation is not used', !injRule.findings.some((f) => f.ruleId === 'x'));

// Code with backticks and | cannot end a code block or split a table row of the AI prompt / report
{
  const { buildAiPrompt, buildReport } = require('../src/report');
  const tickSrc = "REPORT z.\nDATA lv_a TYPE string.\nMOVE ```x``` TO lv_a.\nWRITE / 'a|b'.\n";
  const files = [{ path: 'z.abap', result: analyze(tickSrc, {}) }];
  const prompt = buildAiPrompt(files, {});
  const report = buildReport(files);
  check('AI prompt: the source block is fenced with more backticks than the code has', /\n````abap\n[\s\S]*MOVE ```x``` TO lv_a\.[\s\S]*\n````\n/.test(prompt));
  const rows = (md) => md.split('\n').filter((l) => /^\| \d+ \|/.test(l));
  const cols = (l) => l.replace(/\\\|/g, '').split('|').length;
  check('report: every table row keeps its columns', rows(report).length > 0 && rows(report).every((l) => cols(l) === cols(rows(report)[0])), rows(report).join('\n'));
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
