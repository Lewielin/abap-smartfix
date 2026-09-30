'use strict';

/**
 * Tests of the SCI checks in rules-sci.js and of the annotation names: every name is checked against the SCI message catalog
 * of an S/4HANA system (src/sci-catalog.js with src/sci-messages.js),
 * and learning names from a code base and the self-check of rewrites are tested.
 * Run:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test\sci.js
 */

const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/analyzer');
const { RULES } = require('../src/rules');
const { SCI_RULES } = require('../src/rules-sci');
const { planEdits, applyEditsToText } = require('../src/fixer');
const { learnAnnotations } = require('../src/learn');
const { verifyRewrites, downgradeRejected } = require('../src/verify');
const { PSEUDO_TO_PRAGMA } = require('../src/pseudo-pragmas');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sci-checks.abap'), 'utf8');
const srcLines = text.split(/\r?\n/);
/** 1-based line of the first source line matching re, searching from the line after `after` */
const lineOf = (re, after) => srcLines.findIndex((l, i) => i >= (after || 0) && re.test(l)) + 1;
const fix = (src, opts) => {
  const r = analyze(src, opts || {});
  return { r, out: applyEditsToText(src, planEdits(r.lines, r.comments, r.findings).edits) };
};

// ------------------------------------------------------------------ annotation names
console.log('\n== Annotation names are those of the SCI message catalog ==');
const messages = require('../src/sci-catalog');
const allRules = RULES.concat(SCI_RULES);
for (const r of allRules.filter((x) => x.token)) {
  for (const t of [r.token, r.altToken].filter(Boolean)) {
    const pragma = /^##/.test(t);
    const name = t.replace(/^"#EC\s+/, '').replace(/^##/, '');
    // The catalog has no message texts: a message of the rule's own check classes with that annotation
    const hit = messages.find((m) => r.sci.classes.indexOf(m.clsname) >= 0 &&
      (pragma ? m.pragma === name : m.pcom === name || m.pcom_alt === name));
    // Extended program check messages missing from the catalog: confirmed by SLIN_DESC (obsolete pseudo comment → pragma)
    const slin = !hit && pragma && r.sci.slin && r.sci.classes.indexOf('CL_CI_TEST_EXTENDED_CHECK') >= 0 &&
      r.sci.slin.every((p) => PSEUDO_TO_PRAGMA[p] === t);
    check(r.id + ': ' + t + (hit ? ' = ' + hit.clsname + ' ' + hit.code : slin ? ' = SLIN_DESC ' + r.sci.slin.join(' / ') : ''), !!hit || slin);
  }
}
check('every rule with an annotation names its SCI check class', allRules.filter((r) => r.token).every((r) => r.sci && r.sci.classes.length));
const removed = ['select-star', 'sort-without-by', 'db-call-in-loop', 'select-then-delete', 'complex-where', 'select-star-corresponding',
  'oracle-rule-hint', 'stxh-access', 'rfc-callback', 'auth-check-dummy', 'append-to-sorted', 'critical-statement', 'naming-convention'];
check('checks whose name or position could not be confirmed are not included', removed.every((id) => !allRules.some((r) => r.id === id)));

// ------------------------------------------------------------------ detection
console.log('\n== Detection (samples/sci-checks.abap) ==');
const base = analyze(text, {});
const has = (line, id) => base.findings.some((f) => f.startLine + 1 === line && f.ruleId === id);
const lines = (id) => base.findings.filter((f) => f.ruleId === id).map((f) => f.startLine + 1);

const L = {
  modifyInLoop: lineOf(/MODIFY ztab_log FROM gs_log/),
  updateInLoop: lineOf(/UPDATE ztab_log FROM gs_log/),
  sortHoist: lineOf(/SORT gt_marc BY matnr werks/),
  sortStays: lineOf(/SORT gt_marc BY matnr\.$/),
  exitSelect: lineOf(/SELECT matnr FROM mara INTO gs_mara-matnr WHERE/),
  condExitSelect: lineOf(/SELECT \* FROM mara INTO gs_mara WHERE/),
  fae: lineOf(/FOR ALL ENTRIES IN gt_mara/),
  faeOkIf: lineOf(/FOR ALL ENTRIES IN gt_mara/, lineOf(/FOR ALL ENTRIES IN gt_mara/)),
  faeOkReturn: lineOf(/FOR ALL ENTRIES IN gt_log/),
  updateAll: lineOf(/UPDATE ztab_log SET counter = 0/),
  deleteAll: lineOf(/DELETE FROM ztab_log\./),
  dynDelete: lineOf(/DELETE FROM \(gv_tab\)/),
  dynWhere: lineOf(/WHERE \(gv_where\)/),
  parenWhere: lineOf(/WHERE \( mtart = 'FERT' OR/),
  execSql: lineOf(/EXEC SQL/),
  rollback: lineOf(/ROLLBACK WORK/),
  atNew: lineOf(/AT NEW matnr/),
  atNewOk: lineOf(/AT NEW matnr/, lineOf(/AT NEW matnr/)),
  loopModify: lineOf(/LOOP AT gt_mara INTO gs_mara\./, lineOf(/\* loop-modify-from-wa/)),
  nested: lineOf(/READ TABLE gt_marc TRANSPORTING NO FIELDS WITH KEY matnr = gs_mara-matnr\.$/),
  intf: lineOf(/go_reader->read/),
};

check('db-change-in-loop: MODIFY and UPDATE inside loops', has(L.modifyInLoop, 'db-change-in-loop') && has(L.updateInLoop, 'db-change-in-loop'));
check('sort-in-loop: both SORTs in loops', has(L.sortHoist, 'sort-in-loop') && has(L.sortStays, 'sort-in-loop'));
check('select-exit: unconditional and conditional EXIT', has(L.exitSelect, 'select-exit') && has(L.condExitSelect, 'select-exit'));
check('select-then-check', lines('select-then-check').join() === String(L.condExitSelect), lines('select-then-check').join());
check('fae-without-check: only the unguarded SELECT', lines('fae-without-check').join() === String(L.fae), lines('fae-without-check').join());
check('fae-without-check: IF … IS NOT INITIAL and IF … IS INITIAL. RETURN. guard it',
  !has(L.faeOkIf, 'fae-without-check') && !has(L.faeOkReturn, 'fae-without-check'));
check('change-without-where: UPDATE … SET and DELETE FROM without WHERE',
  lines('change-without-where').join() === L.updateAll + ',' + L.deleteAll, lines('change-without-where').join());
check('dynamic-sql and client-specified also on database changes', has(L.dynDelete, 'dynamic-sql') && has(L.dynDelete, 'client-specified'));
check('dynamic-where: WHERE (name), not WHERE ( condition )', lines('dynamic-where').join() === String(L.dynWhere), lines('dynamic-where').join());
check('a dynamic WHERE is not reported as a dynamic table', !has(L.dynWhere, 'dynamic-sql'));
check('critical statements get their own pseudo comment',
  has(L.execSql, 'critical-exec-sql') && has(L.rollback, 'critical-rollback') &&
  base.findings.find((f) => f.ruleId === 'critical-exec-sql').token === '"#EC CI_EXECSQL');
check('at-in-restricted-loop: AT NEW in LOOP … WHERE, not in a LOOP over the whole table',
  lines('at-in-restricted-loop').join() === String(L.atNew), lines('at-in-restricted-loop').join());
check('loop-modify-from-wa', has(L.loopModify, 'loop-modify-from-wa'));
check('nested-linear-search only inside a loop', lines('nested-linear-search').join() === String(L.nested), lines('nested-linear-search').join());
check('the same READ is not also reported by linear-search', !has(L.nested, 'linear-search'));
check('interface-call-in-loop', lines('interface-call-in-loop').join() === String(L.intf));

// ------------------------------------------------------------------ rewrites
console.log('\n== Rewrites ==');
const auto = fix(text, {});
check('default: safe rewrite applied (SELECT … EXIT → UP TO 1 ROWS)',
  auto.out.indexOf("  SELECT matnr FROM mara INTO gs_mara-matnr UP TO 1 ROWS WHERE mtart = 'FERT'.") >= 0);
check('default: review rewrites not applied (FAE wrap, array MODIFY)',
  !/IF gt_mara IS NOT INITIAL\.\r?\n  SELECT \* FROM marc/.test(auto.out) && /MODIFY ztab_log/.test(auto.out));
check('default: annotations added (CI_FAE_LINES_ENSURED, CI_IMUD_NESTED, CI_NOWHERE on UPDATE, CI_SORTLOOP, CI_EXECSQL)',
  /#EC CI_FAE_LINES_ENSURED/.test(auto.out) && /#EC CI_IMUD_NESTED/.test(auto.out) && /UPDATE ztab_log SET counter = 0\. "#EC CI_NOWHERE/.test(auto.out) &&
    /#EC CI_SORTLOOP/.test(auto.out) && /#EC CI_EXECSQL/.test(auto.out));
// The SELECT into gt_marc feeds LOOP AT gt_marc … AT NEW with no SORT in between: only ORDER BY (review) or a SORT fixes it
check('default: everything else is fixed or annotated', analyze(auto.out, {}).findings.every((f) => f.ruleId === 'select-no-order-by' && f.action === 'manual'),
  analyze(auto.out, {}).findings.map((f) => f.startLine + 1 + ':' + f.ruleId + ':' + f.action).join(', '));

const rw = fix(text, { fixMode: 'rewrite' });
const out = rw.out;
check('LOOP … MODIFY dbtab FROM wa … ENDLOOP → MODIFY dbtab FROM TABLE itab',
  out.indexOf('  MODIFY ztab_log FROM TABLE gt_log.') >= 0 && out.indexOf('    MODIFY ztab_log FROM gs_log.') < 0);
check('a loop with other statements is not turned into an array operation', /UPDATE ztab_log(?:\s|"#EC \S+)*FROM gs_log/.test(out));
const outLines = out.split(/\r?\n/);
const hoisted = outLines.indexOf('  SORT gt_marc BY matnr werks.');
check('SORT moved in front of the loop that only reads the table',
  hoisted > 0 && /^  LOOP AT gt_mara INTO gs_mara\.$/.test(outLines[hoisted + 1]) && !/^    SORT gt_marc BY matnr werks/.test(outLines[hoisted + 2]),
  outLines.slice(hoisted - 1, hoisted + 3).join(' | '));
check('SORT stays in a loop that changes the table', out.indexOf('    SORT gt_marc BY matnr.') >= 0 || /\n    SORT gt_marc BY matnr\. "#EC/.test(out));
check('conditional EXIT is left alone', /      EXIT\./.test(out));
const faeAt = outLines.indexOf('  IF gt_mara IS NOT INITIAL.');
check('FAE wrapped together with its sy-subrc check, code not re-indented',
  faeAt > 0 && /^  SELECT \* FROM marc INTO TABLE gt_marc FOR ALL ENTRIES IN gt_mara/.test(outLines[faeAt + 1]) &&
    outLines[faeAt + 2] === '  IF sy-subrc <> 0.' && outLines[faeAt + 4] === '  ENDIF.' && outLines[faeAt + 5] === '  ENDIF.',
  outLines.slice(faeAt, faeAt + 6).join(' | '));
check('every rewrite passes the self-check',
  verifyRewrites(text, rw.r, rw.r.findings, (t) => analyze(t, { fixMode: 'rewrite' })).size === 0);
check('rewrites leave nothing to rewrite', analyze(out, { fixMode: 'rewrite' }).findings.every((f) => f.action !== 'rewrite'));

// ------------------------------------------------------------------ learning
console.log('\n== Learn annotation names from the code base ==');
const learnSrc = (n, token) => ['REPORT z.', 'START-OF-SELECTION.', '  LOOP AT lt_a INTO ls_a.']
  .concat(Array.from({ length: n }, (_, i) => '    SORT lt_b' + i + ' BY f. ' + token))
  .concat(['  ENDLOOP.']).join('\n');
const learned = learnAnnotations([
  { path: 'a.abap', text: learnSrc(2, '"#EC CI_SORT_IN_LOOP') },
  { path: 'b.abap', text: learnSrc(2, '"#EC CI_SORT_IN_LOOP') },
  { path: 'e.abap', text: ['REPORT z.', 'START-OF-SELECTION.', '  LOOP AT lt_a INTO ls_a.', '    READ TABLE lt_c TRANSPORTING NO FIELDS WITH KEY f = 1. "#EC CI_XYZ',
    '    IF sy-subrc = 0. ENDIF.', '  ENDLOOP.'].join('\n') },
], {});
const sortSug = learned.suggestions.find((s) => s.ruleId === 'sort-in-loop');
check('consistent use of another name becomes a suggestion', !!sortSug && sortSug.token === '"#EC CI_SORT_IN_LOOP' && sortSug.votes === 4, JSON.stringify(learned.suggestions));
check('one vote is not enough', !learned.suggestions.some((s) => s.ruleId === 'nested-linear-search'));
const own = learnAnnotations([{ path: 'f.abap', text: learnSrc(3, '"#EC CI_SORTLOOP') }], {});
check('the rule\'s own name is not suggested', own.suggestions.length === 0, JSON.stringify(own));
check('tokenOverrides replace a name', analyze(text, { tokenOverrides: { 'sort-in-loop': '"#EC CI_SORT_LOOP' } })
  .findings.filter((f) => f.ruleId === 'sort-in-loop').every((f) => f.token === '"#EC CI_SORT_LOOP' && f.tokenSource === 'setting'));

// ------------------------------------------------------------------ CI_VALPAR / ##FM_SUBRC_OK
console.log('\n== Internal tables passed by VALUE, sy-subrc after CALL FUNCTION ==');
const vpSrc = [
  'CLASS lcl DEFINITION.',
  '  PUBLIC SECTION.',
  '    TYPES tty_a TYPE STANDARD TABLE OF mara WITH EMPTY KEY.',
  '    TYPES: BEGIN OF ty_s, a TYPE i, END OF ty_s.',
  '    METHODS get_a EXPORTING VALUE(rt_a) TYPE tty_a.',
  '    METHODS get_ret EXPORTING VALUE(rt_ret) TYPE zsf_demo_ret_t.',
  '    METHODS get_ddic EXPORTING VALUE(rt_x) TYPE zsf_demo_ret_t.',
  '    METHODS get_s EXPORTING VALUE(rs) TYPE ty_s.',
  '    METHODS set_tab IMPORTING VALUE(it_a) TYPE STANDARD TABLE it_b TYPE tty_a.',
  'ENDCLASS.',
  'CLASS lcl IMPLEMENTATION.',
  '  METHOD get_a.',
  "    CALL FUNCTION 'Z_FM' TABLES t = rt_a EXCEPTIONS not_found = 1 OTHERS = 2. \"#EC CI_SUBRC",
  '  ENDMETHOD.',
  '  METHOD get_ret.',
  "    APPEND VALUE #( type = 'E' ) TO rt_ret.",
  "    CALL FUNCTION 'Z_FM' EXCEPTIONS OTHERS = 1.",
  "    CALL FUNCTION 'Z_FM2' EXCEPTIONS OTHERS = 1.",
  '    IF sy-subrc <> 0.',
  '    ENDIF.',
  '  ENDMETHOD.',
  '  METHOD get_ddic.',
  '    CLEAR rt_x.',
  '  ENDMETHOD.',
  '  METHOD get_s.',
  '  ENDMETHOD.',
  '  METHOD set_tab.',
  '  ENDMETHOD.',
  'ENDCLASS.',
  '',
].join('\n');
const vp = analyze(vpSrc, {});
const vpAt = (line, id) => vp.findings.filter((f) => f.startLine + 1 === line && f.ruleId === id);
check('EXPORTING VALUE( ) table of a local table type: "#EC CI_VALPAR on the METHOD of the implementation', vpAt(12, 'value-param-table').length === 1);
check('EXPORTING VALUE( ) DDIC type used as a table in the method (APPEND … TO): reported', vpAt(15, 'value-param-table').length === 1);
check('EXPORTING VALUE( ) DDIC type not used as a table: not reported (type unknown)', vpAt(22, 'value-param-table').length === 0);
check('EXPORTING VALUE( ) structure: not reported', vpAt(25, 'value-param-table').length === 0);
check('IMPORTING VALUE( ) TYPE STANDARD TABLE reported, by-reference table not listed',
  vpAt(27, 'value-param-table').length === 1 && vpAt(27, 'value-param-table')[0].detail === 'it_a');
const ret = analyze([
  'CLASS lcl DEFINITION.', '  PRIVATE SECTION.', '    TYPES tty_fset TYPE STANDARD TABLE OF string WITH EMPTY KEY.',
  '    METHODS get_col_headers', '      RETURNING VALUE(rt_fset) TYPE tty_fset.', 'ENDCLASS.',
  'CLASS lcl IMPLEMENTATION.', '  METHOD get_col_headers.', "    rt_fset = VALUE #( ( `A` ) ( `B` ) ).", '  ENDMETHOD.', 'ENDCLASS.', '',
].join('\n'), {});
check('RETURNING VALUE( ) table (always by value): no "#EC CI_VALPAR', !ret.findings.some((f) => f.ruleId === 'value-param-table'));
check('CALL FUNCTION … EXCEPTIONS without sy-subrc: ##FM_SUBRC_OK, not CI_SUBRC',
  vpAt(17, 'fm-subrc-not-checked').length === 1 && vpAt(17, 'subrc-not-checked').length === 0);
check('CALL FUNCTION … EXCEPTIONS with sy-subrc checked: not reported', vpAt(18, 'fm-subrc-not-checked').length === 0);
const vpFixed = applyEditsToText(vpSrc, planEdits(vp.lines, vp.comments, vp.findings).edits).split('\n');
check('"#EC CI_SUBRC on CALL FUNCTION is replaced by ##FM_SUBRC_OK',
  vpFixed[12] === "    CALL FUNCTION 'Z_FM' TABLES t = rt_a EXCEPTIONS not_found = 1 OTHERS = 2 ##FM_SUBRC_OK.", vpFixed[12]);
check('METHOD get_a. "#EC CI_VALPAR', vpFixed[11] === '  METHOD get_a. "#EC CI_VALPAR', vpFixed[11]);
check('obsolete "#EC FB_RC is left to obsolete-pseudo-comment',
  analyze("REPORT z.\nSTART-OF-SELECTION.\n  CALL FUNCTION 'Z_FM' EXCEPTIONS OTHERS = 1. \"#EC FB_RC\n", {})
    .findings.map((f) => f.ruleId).join() === 'obsolete-pseudo-comment');

// ------------------------------------------------------------------ Native SQL, SELECT * field usage 
console.log('\n== Native SQL, SELECT * field usage ==');
const zpSrc = [
  'REPORT z_demo_md.',
  'TABLES: mara, marm.',
  'DATA: lt_md05 TYPE STANDARD TABLE OF zsf_demo_item WITH HEADER LINE.',
  'START-OF-SELECTION.',
  '  SELECT SINGLE * FROM mara',
  '   WHERE matnr = lt_md05-matnr',
  "     AND meins = 'PC'.",
  '  IF sy-subrc = 0.',
  '    SELECT SINGLE * FROM marm',
  "     WHERE matnr = lt_md05-matnr AND meinh = 'EA'.",
  '    lt_md05-mng01 = lt_md05-mng02 * marm-umren.',
  '  ENDIF.',
  '  EXEC SQL.',
  "    delete from ZSF_DEMO_TARGET where PLWRK <> ''",
  '  ENDEXEC.',
  '  EXEC SQL.',
  '    insert into ZSF_DEMO_TARGET ( MATNR, MNG01 ) values ( :lt_md05-MATNR, :lt_md05-MNG01 )',
  '  ENDEXEC.',
  'FORM fix_nobom.',
  '  DATA: lt_plaf TYPE TABLE OF plaf,',
  '        ls_plaf TYPE plaf.',
  "  SELECT * FROM plaf INTO TABLE lt_plaf WHERE auffx = ''.",
  '  LOOP AT lt_plaf INTO ls_plaf.',
  "    CALL FUNCTION 'Z_X' EXPORTING i_plnum = ls_plaf-plnum i_matnr = ls_plaf-matnr.",
  '  ENDLOOP.',
  'ENDFORM.',
  'FORM whole_row.',
  '  DATA lt_mara TYPE TABLE OF mara.',
  "  SELECT * FROM mara INTO TABLE lt_mara WHERE mtart = 'FERT'.",
  '  LOOP AT lt_mara INTO DATA(ls_mara).',
  '    APPEND ls_mara TO gt_all.',
  '  ENDLOOP.',
  'ENDFORM.',
  '',
].join('\n');
const zp = analyze(zpSrc, {});
const zpAt = (line) => zp.findings.filter((f) => f.startLine + 1 === line).map((f) => f.ruleId);
check('EXEC SQL: "#EC CI_EXECSQL on each EXEC SQL', zpAt(13).indexOf('critical-exec-sql') >= 0 && zpAt(16).indexOf('critical-exec-sql') >= 0);
check('Native SQL between EXEC SQL and ENDEXEC is not analyzed as ABAP (no CI_SUBRC in the SQL)', zpAt(14).length === 0 && zpAt(17).length === 0,
  JSON.stringify([zpAt(14), zpAt(17)]));
// EXEC SQL … ENDEXEC is one statement that ends with the period after ENDEXEC: its pseudo comment goes there
const nsql = (execLine, endLine) => ['REPORT z.', execLine, "    DISCONNECT :'SMIBI'", endLine, ''].join('\n');
const ns1 = fix(nsql('  EXEC SQL.', '  ENDEXEC.'));
check('EXEC SQL … ENDEXEC: "#EC CI_EXECSQL after ENDEXEC., not after EXEC SQL.',
  ns1.out === nsql('  EXEC SQL.', '  ENDEXEC. "#EC CI_EXECSQL'), ns1.out);
check('EXEC SQL … ENDEXEC. "#EC CI_EXECSQL: annotated, not reported again',
  !analyze(nsql('  EXEC SQL.', '  ENDEXEC. "#EC CI_EXECSQL'), {}).findings.some((f) => f.ruleId === 'critical-exec-sql'));
const ns2 = fix(nsql('  EXEC SQL. "#EC CI_EXECSQL', '  ENDEXEC.'));
check('EXEC SQL. "#EC CI_EXECSQL (no effect there) is moved after ENDEXEC.',
  ns2.r.findings.some((f) => f.ruleId === 'critical-exec-sql') && ns2.out === nsql('  EXEC SQL.', '  ENDEXEC. "#EC CI_EXECSQL'), ns2.out);
const ns3 = fix(nsql('  EXEC SQL. " connection', '  ENDEXEC. " close it'));
check('regular comments stay; the pseudo comment goes in front of the comment after ENDEXEC.',
  ns3.out === nsql('  EXEC SQL. " connection', '  ENDEXEC. "#EC CI_EXECSQL close it'), ns3.out);
check('SELECT SINGLE * into the TABLES work area, only sy-subrc used: Existence check', zpAt(5).indexOf('select-star-existence') >= 0);
check('SELECT SINGLE * with one field used: can be transformed', zpAt(9).indexOf('select-star-few-fields') >= 0);
check('SELECT * INTO TABLE read through LOOP … INTO with 2 fields used: can be transformed',
  zp.findings.some((f) => f.startLine + 1 === 22 && f.ruleId === 'select-star-few-fields' && f.detail === 'fields used: matnr, plnum'));
check('whole row used (APPEND ls TO …): not reported', zpAt(29).filter((id) => /^select-star/.test(id)).length === 0);
const zpDd = analyze(zpSrc, { ddic: require('../src/ddic').viewOf(new Map([['PLAF', { category: 'table', keys: ['MANDT', 'PLNUM'], keysComplete: true, fieldCount: 8, hasIncludes: false }]])) });
check('with DDIC: 2 of 8 fields (25%) is not "few"', !zpDd.findings.some((f) => f.startLine + 1 === 22 && f.ruleId === 'select-star-few-fields'));

// ------------------------------------------------------------------ further cases
console.log('\n== REFRESH chain, client field, CJK text, SELECT * type references, JOIN keys ==');
const yrSrc = [
  'REPORT z_demo_po.',
  'TABLES ekpo.',
  'DATA: lt_out_h TYPE STANDARD TABLE OF ekko WITH HEADER LINE,',
  '      lt_out_d TYPE STANDARD TABLE OF ekpo WITH HEADER LINE,',
  '      l_brtwr  TYPE ekpo-brtwr.',
  'START-OF-SELECTION.',
  '  refresh: lt_out_h, lt_out_d.',
  '  select ebeln into table lt_out_h from ekko',
  '   where bukrs = l_bukrs',
  '     and mandt = sy-mandt',
  '   order by ebeln.',
  "  l_attention0 = '註'.",
  "  CALL FUNCTION 'READ_TEXT' EXPORTING object = 'EKPO' TABLES lines = lt_lines EXCEPTIONS OTHERS = 1.",
  '  IF sy-subrc = 0. ENDIF.',
  "  select * from ekpo where ebeln = lt_out_h-ebeln and loekz = ''.",
  '    n = n + 1.',
  '  endselect.',
  '',
].join('\n');
const yr = analyze(yrSrc, {});
const yrAt = (line) => yr.findings.filter((f) => f.startLine + 1 === line).map((f) => f.ruleId);
const yrFixed = applyEditsToText(yrSrc, planEdits(yr.lines, yr.comments, yr.findings).edits).split('\n');
check('chained REFRESH → CLEAR: a[], b[] (header lines), once for the whole chain', yrFixed[6] === '  CLEAR: lt_out_h[], lt_out_d[].', yrFixed[6]);
check('client field compared with sy-mandt: the condition line is removed',
  yrFixed[8] === '   where bukrs = l_bukrs' && /^   order by ebeln\./.test(yrFixed[9]), JSON.stringify(yrFixed.slice(7, 11)));
check('one CJK character is a text: ##NO_TEXT', yrAt(12).indexOf('text-literal') >= 0);
check('SELECT * into the TABLES work area: TYPE ekpo-… and \'EKPO\' literals are no field use → Existence check',
  yrAt(15).indexOf('select-star-existence') >= 0, JSON.stringify(yrAt(15)));
check('client value other than sy-mandt: reported, not rewritten',
  (() => { const r = analyze("REPORT z.\nSTART-OF-SELECTION.\n  SELECT SINGLE a FROM ekko INTO lv WHERE mandt = lv_client AND ebeln = '1'.\n", {});
    const f = r.findings.find((x) => x.ruleId === 'client-field-in-where'); return !!f && f.action === 'manual'; })());
const DDv = require('../src/ddic');
const jk = (cl, ...keys) => ({ category: 'table', keys: [cl, ...keys], clientKey: cl, keysComplete: true });
const joinSrc = "REPORT z.\nSTART-OF-SELECTION.\n  SELECT SINGLE b~name1 INTO lv FROM lfa1 AS a INNER JOIN adrc AS b ON a~adrnr = b~addrnumber WHERE a~lifnr = lv_lifnr AND b~nation = ' '.\n";
const jr = analyze(joinSrc, { ddic: DDv.viewOf(new Map([['LFA1', jk('MANDT', 'LIFNR')], ['ADRC', jk('CLIENT', 'ADDRNUMBER', 'DATE_FROM', 'NATION')]])) });
const jf = jr.findings.find((f) => f.ruleId === 'select-single');
check('SELECT SINGLE with JOIN (DDIC): key field of the joined table not determined', !!jf && jf.detail === 'key fields not in the WHERE: b~date_from',
  jf && jf.detail);

// ------------------------------------------------------------------ self-check
console.log('\n== Self-check of rewrites ==');
const breaking = [{ id: 'drop-if', title: 'drop IF', match: '^IF\\s+lv_x\\s*=\\s*1$', replace: 'lv_y = 1' }];
const brokenSrc = 'REPORT z.\nSTART-OF-SELECTION.\n  IF lv_x = 1.\n    WRITE / 1.\n  ENDIF.\n';
const br = analyze(brokenSrc, { customRules: breaking });
const rejected = verifyRewrites(brokenSrc, br, br.findings, (t) => analyze(t, { customRules: breaking }));
check('a rewrite that breaks IF / ENDIF is rejected', rejected.size === 1 && /block structure/.test([...rejected.values()][0]));
downgradeRejected(br.findings, rejected);
const brPlan = planEdits(br.lines, br.comments, br.findings);
check('the rejected rewrite becomes manual with the reason', brPlan.edits.length === 0 &&
  brPlan.unfixable.some((u) => /did not pass the self-check \(the block structure would change\)/.test(u.reason)));
const stays = [{ id: 'no-op', title: 'no-op', match: '^WRITE\\s+/\\s+(\\S+)$', replace: 'WRITE /  $1' }];
const stSrc = 'REPORT z.\nSTART-OF-SELECTION.\n  WRITE / lv_a.\n';
const st = analyze(stSrc, { customRules: stays });
check('a rewrite after which the finding is still there is rejected',
  /still be reported/.test([...verifyRewrites(stSrc, st, st.findings, (t) => analyze(t, { customRules: stays })).values()][0] || ''));

// The annotation of a statement a rewrite replaced goes to the rewritten statement: one fix run is enough
const arSrc = ['REPORT z.', 'START-OF-SELECTION.', '  LOOP AT gt_log INTO gs_log.', '    MODIFY ztab_log FROM gs_log.', '  ENDLOOP.', ''].join('\n');
const ar = analyze(arSrc, { fixMode: 'rewrite' });
const arFixed = applyEditsToText(arSrc, planEdits(ar.lines, ar.comments, ar.findings).edits);
const ar2 = analyze(arFixed, { fixMode: 'rewrite' });
check('LOOP … MODIFY … ENDLOOP → MODIFY … FROM TABLE keeps "#EC CI_SUBRC of the MODIFY, nothing left for a second run',
  arFixed.split('\n')[2] === '  MODIFY ztab_log FROM TABLE gt_log. "#EC CI_SUBRC' && planEdits(ar2.lines, ar2.comments, ar2.findings).edits.length === 0,
  arFixed.split('\n')[2]);

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
