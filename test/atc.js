'use strict';

/**
 * Tests of matching a real ATC result to the findings (src/atc.js).
 * samples/atc-demo.abap (an invented program) with the kind of findings ATC reports in an S/4HANA system, as ADT for VS Code
 * publishes them (source "ATC", code "<check class> - <message id>", message, line).
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test\atc.js
 */

const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/analyzer');
const Atc = require('../src/atc');
const { verifyRewrites } = require('../src/verify');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'atc-demo.abap'), 'utf8');
// 1-based line of the first line matching re (the sample is invented; lines are found, not hard-coded)
const lineOf = (re, from) => text.split(/\r?\n/).findIndex((l, i) => i >= (from || 0) && re.test(l)) + 1;
const L = {
  refresh: lineOf(/REFRESH lt_mdkp/),
  mara: lineOf(/SELECT SINGLE \* FROM mara/),
  marm: lineOf(/SELECT SINGLE \* FROM marm/),
  mbew: lineOf(/SELECT SINGLE bklas FROM mbew/),
  plaf: lineOf(/SELECT \* FROM plaf/),
  text: lineOf(/gv_text = 'Update/),
  sql: text.split(/\r?\n/).map((l, i) => (/^\s*EXEC SQL\./.test(l) ? i + 1 : 0)).filter(Boolean),
};
const diag = (line, cls, id, message, severity) =>
  ({ source: 'ATC', code: cls + ' - ' + id, message, severity: severity == null ? 1 : severity, range: { start: { line: line - 1 } } });
const adtDiagnostics = [
  diag(L.mara, 'CL_CI_TEST_ANALYZE_SELECT_DIA', '0002', 'Existence check. No fields used', 2),
  diag(L.marm, 'CL_CI_TEST_ANALYZE_SELECT_DIA', '0001', 'Select-Statement can be transformed. 3% of fields used'),
  diag(L.plaf, 'CL_CI_TEST_ANALYZE_SELECT_DIA', '0001', 'Select-Statement can be transformed. 2% of fields used', 2),
  ...L.sql.map((l) => diag(l, 'CL_CI_TEST_CRITICAL_STATEMENTS', '0005', 'Use of Native SQL')),
  diag(L.mbew, 'CL_CI_TEST_NO_ORDER_BY', 'AMB_SINGLE', 'SELECT SINGLE is possibly not unique'),
  diag(L.text, 'CL_CI_TEST_EXTENDED_CHECK', '0100', 'Text element missing in a character string'),
  { source: 'ABAP', code: 'x', message: 'syntax warning of another source', range: { start: { line: 10 } } },
];
const atcCount = adtDiagnostics.length - 1;

console.log('\n== Reading ADT diagnostics ==');
const atc = Atc.readAtcDiagnostics(adtDiagnostics);
check('only source "ATC", ' + atcCount + ' findings', atc.length === atcCount, String(atc.length));
check('check class and message id from the code', atc[0].checkClass === 'CL_CI_TEST_ANALYZE_SELECT_DIA' && atc[0].messageId === '0002' && atc[0].line === L.mara - 1);
check('check class families (…_DIA / _HANA)', Atc.classFamily('CL_CI_TEST_ANALYZE_SELECT_HANA') === Atc.classFamily('CL_CI_TEST_ANALYZE_SELECT_DIA'));

console.log('\n== Matching ==');
const base = analyze(text, {});
const m = Atc.matchAtc(base, atc);
check('all ATC findings but SELECT SINGLE on MBEW (which needs the DDIC) matched to rules', m.confirmed.size === atcCount - 1, String(m.confirmed.size));
check('the unmatched one is the SELECT SINGLE on MBEW', m.unmatched.length === 1 && m.unmatched[0].atc.line === L.mbew - 1, JSON.stringify(m.unmatched.map((u) => u.atc.line + 1)));
const hiddenRules = new Set(base.findings.filter((f) => m.unconfirmed.has(f.key)).map((f) => f.ruleId));
check('findings ATC does not report are hidden (CI_SUBRC, CI_SEL_NESTED, CI_STDSEQ)',
  ['subrc-not-checked', 'select-in-loop', 'nested-linear-search'].every((id) => hiddenRules.has(id)), [...hiddenRules].join());
check('rewrites without an SCI check stay (REFRESH → CLEAR)', !hiddenRules.has('obsolete-refresh'));

const state = Object.assign({ version: 1 }, m);
const shown = Atc.applyAtc(analyze(text, {}), state, true);
const ids = (line) => shown.findings.filter((f) => f.startLine + 1 === line).map((f) => f.ruleId);
check('after applying: Native SQL, SELECT *, text literal and REFRESH remain',
  ids(L.sql[0])[0] === 'critical-exec-sql' && ids(L.mara)[0] === 'select-star-existence' && ids(L.text)[0] === 'text-literal' &&
  ids(L.refresh).indexOf('obsolete-refresh') >= 0);
check('after applying: no CI_SUBRC / CI_SEL_NESTED', !shown.findings.some((f) => f.ruleId === 'subrc-not-checked' || f.ruleId === 'select-in-loop'));
const ss = shown.findings.filter((f) => f.startLine + 1 === L.mbew && f.ruleId === 'select-single');
check('ATC confirms a message a rule stands for (SELECT SINGLE on MBEW): the rule annotation "#EC CI_NOORDER is added',
  ss.length === 1 && ss[0].action === 'suppress' && ss[0].token === '"#EC CI_NOORDER', JSON.stringify(ss.map((f) => [f.action, f.token])));
const { planEdits, applyEditsToText } = require('../src/fixer');
const fixed = applyEditsToText(text, planEdits(shown.lines, shown.comments, shown.findings).edits);
const again = Atc.applyAtc(analyze(fixed, {}), state, false);
check('after the fix nothing ATC reported is left (no endless re-annotation)',
  again.findings.filter((f) => f.ruleId !== 'obsolete-refresh').length === 0, again.findings.map((f) => f.startLine + 1 + ':' + f.ruleId).join());
// ATC reports Native SQL on the EXEC SQL line; the statement ends with ENDEXEC., which takes the pseudo comment
const fixedLines = fixed.split(/\r?\n/);
check('Native SQL reported on EXEC SQL: "#EC CI_EXECSQL after each ENDEXEC., not after EXEC SQL.',
  L.sql.every((l) => !/#EC/.test(fixedLines[l - 1])) &&
  fixedLines.filter((l) => /^\s*ENDEXEC\.\s*"#EC CI_EXECSQL\s*$/.test(l)).length === L.sql.length,
  fixedLines.filter((l) => /EXEC/.test(l)).join(' | '));

const other = Atc.matchAtc(base, [diag(13, 'CL_CI_TEST_SOMETHING_ELSE', '0001', 'A message no rule knows')].map((d) => Atc.readAtcDiagnostics([d])[0]));
const withManual = Atc.applyAtc(analyze(text, {}), Object.assign({ version: 1 }, other), true);
const manual = withManual.findings.filter((f) => f.ruleId === 'atc');
check('ATC finding no rule stands for: manual finding with the ATC message',
  manual.length === 1 && manual[0].action === 'manual' && /A message no rule knows/.test(manual[0].title));

// After an edit that shifts the lines, the decision follows the statements
const edited = '* added line\n' + text;
const later = Atc.applyAtc(analyze(edited, {}), state, false);
check('after lines shift: hidden findings stay hidden', !later.findings.some((f) => f.ruleId === 'subrc-not-checked'));
check('after lines shift: the ATC-confirmed annotation moves with its statement',
  later.findings.some((f) => f.ruleId === 'select-single' && f.startLine + 1 === L.mbew + 1));

console.log('\n== SLIN and buffer messages go to the right rule ==');
const slSrc = [
  'REPORT z.',
  'START-OF-SELECTION.',
  '  SELECT a~ebeln e~text1 INTO TABLE lt FROM ekko AS a INNER JOIN t052u AS e ON a~zterm = e~zterm',
  '    WHERE a~bukrs = lv_bukrs AND a~mandt = sy-mandt.',
  "  CALL FUNCTION 'Z_FM' EXCEPTIONS OTHERS = 1.",
  "  lv_x = 1.",
  '',
].join('\n');
const slBase = analyze(slSrc, {});
const slAtc = Atc.readAtcDiagnostics([
  diag(3, 'CL_CI_TEST_SELECT_TAW_BYBUF', '0001', 'Buffered table T052U in a JOIN'),
  diag(3, 'CL_CI_TEST_EXTENDED_CHECK', '1504', 'Client field is specified in condition'),
  diag(5, 'CL_CI_TEST_EXTENDED_CHECK', '0303', 'Return codes of function module exceptions are ignored'),
]);
const slM = Atc.matchAtc(slBase, slAtc);
const sl = Atc.applyAtc(analyze(slSrc, {}), Object.assign({ version: 1 }, slM), true);
const slIds = sl.findings.map((f) => f.startLine + 1 + ':' + f.ruleId + (f.token ? ' ' + f.token : ''));
check('"Client field is specified in condition" → the client condition rewrite (not ##FM_SUBRC_OK)', slIds.indexOf('3:client-field-in-where') >= 0, slIds.join());
check('"Buffered table … in a JOIN" → "#EC CI_BUFFJOIN', slIds.indexOf('3:buffered-table-join "#EC CI_BUFFJOIN') >= 0, slIds.join());
check('"Return codes of function module exceptions are ignored" → ##FM_SUBRC_OK', slIds.indexOf('5:fm-subrc-not-checked ##FM_SUBRC_OK') >= 0, slIds.join());
check('no manual leftovers', !sl.findings.some((f) => f.ruleId === 'atc'), slIds.join());

console.log('\n== Annotation from the check message ==');
const mk = (cls, id, msg) => Atc.markerForAtc({ checkClass: cls, messageId: id, message: msg });
check('catalog: pragma of the message (unused fields → ##NEEDED)', mk('CL_CI_TEST_EXTENDED_CHECK', '0906', 'Unused fields').token === '##NEEDED');
check('catalog: pseudo comment when the message has no pragma (CALL TRANSACTION → CI_CALLTA)',
  mk('CL_CI_TEST_CRITICAL_STATEMENTS', '0002', 'Call Transaction ZX').token === '"#EC CI_CALLTA');
check('catalog: a code with several messages is decided by the text', mk('CL_CI_TEST_SYSUBRC', '0002', 'No Handling of SY-SUBRC After Reading Database Statement').token === '"#EC CI_SUBRC');
check('catalog: NOX → no annotation, request an exemption', mk('CL_CI_TEST_SYSUBRC', '0002', 'Program ZX is read-protected').exemption === true);
check('suppressStyle=pseudo prefers the pseudo comment', Atc.markerForAtc({ checkClass: 'CL_CI_TEST_EXTENDED_CHECK', messageId: '0906', message: 'Unused fields' },
  { suppressStyle: 'pseudo' }).token === '"#EC NEEDED');
check('tokenOverrides win over the catalog', Atc.markerForAtc({ checkClass: 'CL_CI_TEST_EXTENDED_CHECK', messageId: '0906', message: 'Unused fields' },
  { tokenOverrides: { 'unused-declaration': '##MY_NEEDED' } }).token === '##MY_NEEDED');
check('fallback: a ##PRAGMA named in the message text', mk('CL_CI_TEST_OTHER', '0001', 'Can be hidden with ##FOO_OK').token === '##FOO_OK');
const exSrc = 'REPORT z.\nSTART-OF-SELECTION.\n  lv_a = 1.\n  lv_b = 2.\n';
const exM = Atc.matchAtc(analyze(exSrc, {}), Atc.readAtcDiagnostics([
  diag(3, 'CL_CI_TEST_EXTENDED_CHECK', '0906', 'Unused fields'),
  diag(4, 'CL_CI_TEST_SYSUBRC', '0002', 'Program ZX is read-protected'),
]));
const ex = Atc.applyAtc(analyze(exSrc, {}), Object.assign({ version: 1 }, exM), true);
check('generic buffer key range not fully specified → "#EC CI_GENBUFF',
  mk('CL_CI_TEST_SELECT_TAW_BYBUF', '', 'Generically buffered key range not fully specified for table UST04').token === '"#EC CI_GENBUFF');
check('fallback: a "#EC pseudo comment named in the message text',
  mk('CL_CI_TEST_OTHER', '0001', 'Finding can be suppressed with pseudo comment "#EC CI_GENBUFF or "#EC CI_SGLSELECT').token === '"#EC CI_GENBUFF');
const exAt = (l) => ex.findings.find((f) => f.startLine + 1 === l);
check('ATC finding no rule produced: annotated with the message\'s own annotation', exAt(3) && exAt(3).action === 'suppress' && exAt(3).token === '##NEEDED');
check('ATC finding that cannot be suppressed: manual, exemption', exAt(4) && exAt(4).action === 'manual' && exAt(4).exemption === true && /exemption/.test(exAt(4).why));

// A UST04 read: CLIENT SPECIFIED on a generically buffered table, one pseudo comment per line
const gbSrc = ['REPORT z.', 'START-OF-SELECTION.', '    OPEN CURSOR WITH HOLD s_cursor FOR', '    SELECT', '    bname', '    mandt', '    profile',
  '    FROM ust04  CLIENT SPECIFIED', '    WHERE mandt =  s_pclien', '    .', ''].join('\n');
const gbAtc = Atc.readAtcDiagnostics([diag(4, 'CL_CI_TEST_SELECT_TAW_BYBUF', '0002', 'Generically buffered key range not fully specified for table UST04')]);
const gb = Atc.applyAtc(analyze(gbSrc, {}), Object.assign({ version: 1 }, Atc.matchAtc(analyze(gbSrc, {}), gbAtc)), true);
const gbFixed = applyEditsToText(gbSrc, planEdits(gb.lines, gb.comments, gb.findings).edits);
const gbLines = gbFixed.split('\n').filter((l) => /"#EC/.test(l));
check('UST04 CLIENT SPECIFIED: "#EC CI_GENBUFF added, at most one pseudo comment per line',
  /"#EC CI_GENBUFF/.test(gbFixed) && gbLines.every((l) => (l.match(/"#EC/g) || []).length === 1), gbFixed);

console.log('\n== ADT for VS Code: diagnostics without a check class ("undefined - <id>") ==');
// ADT 1.1.x publishes the code as u.checkClass + " - " + u.messageId with checkClass undefined
const adt = (line, id, message) => ({ source: 'ATC', code: 'undefined - ' + id, message, severity: 1, range: { start: { line: line - 1 } } });
const ySrc = [
  'REPORT y.',                                                                          // 1
  'PARAMETERS s_pclien TYPE mandt.',                                                    // 2
  'PARAMETERS s_start LIKE sy-datum.',                                                  // 3
  'DATA ls_dd02l TYPE dd02l.',                                                          // 4
  'DATA lv_cols TYPE string.',                                                          // 5
  'DATA it_ush TYPE STANDARD TABLE OF ush02.',                                          // 6
  'DATA it_usr TYPE STANDARD TABLE OF usr02.',                                          // 7
  'DATA it_tstct TYPE STANDARD TABLE OF tstct.',                                        // 8
  'DATA list_tab TYPE STANDARD TABLE OF abaplist.',                                     // 9
  'START-OF-SELECTION.',                                                                // 10
  "SELECT * FROM dd02l INTO ls_dd02l UP TO 1 ROWS",                                     // 11
  "WHERE tabname = 'T685' AND tabclass <> 'VIEW'.",                                     // 12
  'ENDSELECT.',                                                                         // 13
  '    OPEN CURSOR WITH HOLD s_cursor FOR',                                             // 14
  '    SELECT tabname',                                                                 // 15
  '      FROM dd09l.',                                                                  // 16
  '    OPEN CURSOR WITH HOLD s_cursor FOR',                                             // 17
  '    SELECT bname mandt',                                                             // 18
  '    FROM ust04  CLIENT SPECIFIED',                                                   // 19
  '    WHERE mandt =  s_pclien. "#EC CI_CLIENT',                                        // 20
  '    SUBMIT rsm51000_alv',                                                            // 21
  '           AND RETURN EXPORTING LIST TO MEMORY.',                                    // 22
  "    CALL FUNCTION 'LIST_FROM_MEMORY'",                                               // 23
  '      TABLES     listobject = list_tab',                                             // 24
  '      EXCEPTIONS not_found  = 1',                                                    // 25
  '                 OTHERS     = 2.',                                                   // 26
  "    CALL FUNCTION 'LIST_FROM_MEMORY'",                                               // 27
  '      TABLES     listobject = list_tab',                                             // 28
  '      EXCEPTIONS not_found  = 1',                                                    // 29
  '                 OTHERS     = 2.',                                                   // 30
  '    SELECT mandt',                                                                   // 31
  '           bname',                                                                   // 32
  '           MAX( modda ) AS modda',                                                   // 33
  '    FROM ush02  CLIENT SPECIFIED',                                                   // 34
  '    INTO TABLE it_ush',                                                              // 35
  '    WHERE mandt = s_pclien AND modda < s_start "#EC CI_SUBRC',                       // 36
  '    GROUP BY mandt bname.',                                                          // 37
  "    lv_cols = 'GLTGB USTYP BNAME' ##NO_TEXT.",                                       // 38
  '    SELECT',                                                                         // 39
  '    (lv_cols)',                                                                      // 40
  '    FROM usr02 CLIENT SPECIFIED',                                                    // 41
  '    INTO TABLE it_usr',                                                              // 42
  '    .',                                                                              // 43
  '    OPEN CURSOR WITH HOLD s_cursor FOR',                                             // 44
  '    SELECT sprsl tcode',                                                             // 45
  '    FROM tstct',                                                                     // 46
  "    WHERE sprsl = 'EN'.",                                                            // 47
  '',
].join('\n');
const yDiags = [
  adt(11, 'EXISTS', 'Existence check. No fields used'),
  adt(11, 'SEL_UP_TO', 'SELECT .. UP TO .. ROWS without ORDER BY found'),
  adt(14, '0501', 'Large table DD09L: No WHERE condition'),
  adt(19, '0005', 'Generically buffered key range not fully specified for table UST04'),
  adt(21, '1809', 'The program called by SUBMIT RSM51000_ALV does not exist.'),
  adt(23, '1007', "The return code (SY-SUBRC) of the EXCEPTION addition is not processed after CALL FUNCTION 'LIST_FROM_MEMORY'. (This check can be switched off by setting the return codes of all exceptions to 0.)"),
  adt(27, '1007', "The return code (SY-SUBRC) of the EXCEPTION addition is not processed after CALL FUNCTION 'LIST_FROM_MEMORY'. (This check can be switched off by setting the return codes of all exceptions to 0.)"),
  adt(34, 'W247', 'Syntax check warning. Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED". Internal message code: MESSAGE GGC'),
  adt(41, 'W247', 'Syntax check warning. Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED". Internal message code: MESSAGE GGC'),
  adt(47, 'W251', 'Syntax check warning. The type of "\'EN\'" cannot be converted to the type of "SPRSL" Internal message code: MESSAGE GXD'),
];
const yAtc = Atc.readAtcDiagnostics(yDiags);
check('"undefined" is no check class', yAtc.every((a) => a.checkClass === ''));
check('the class is resolved from message id + text (0005 → buffer check, not SY-SUBRC / SUBMIT)',
  JSON.stringify(yAtc[3].classes) === '["CL_CI_TEST_SELECT_TAW_BYBUF"]', JSON.stringify(yAtc[3].classes));
const yOpts = { fixMode: 'auto' };
const yState = Object.assign({ version: 1 }, Atc.matchAtc(analyze(ySrc, yOpts), yAtc));
const y = Atc.applyAtc(analyze(ySrc, yOpts), yState, true, yOpts);
// Rule findings ATC confirms and findings made from ATC alone both carry the reported line
const yAt = (line) => y.findings.filter((f) => f.line === line - 1).map((f) => f.action + ' ' + (f.token || f.ruleId));
const yList = y.findings.map((f) => (f.line != null ? f.line + 1 : '-') + ':' + f.ruleId + ' ' + f.action + ' ' + f.token).join(', ');
check('existence check → "#EC CI_ALL_FIELDS_NEEDED', yAt(11).indexOf('suppress "#EC CI_ALL_FIELDS_NEEDED') >= 0, yList);
check('SELECT … UP TO … ROWS without ORDER BY → "#EC CI_NOORDER', yAt(11).indexOf('suppress "#EC CI_NOORDER') >= 0, yList);
check('large table without WHERE (OPEN CURSOR) → "#EC CI_NOWHERE', yAt(14).indexOf('suppress "#EC CI_NOWHERE') >= 0, yList);
check('generic buffer key range → "#EC CI_GENBUFF, shown on the reported line 19 (not the statement start 17)',
  yAt(19).indexOf('suppress "#EC CI_GENBUFF') >= 0, yList);
check('SUBMIT of a program that does not exist → ##NEEDED', yAt(21).indexOf('suppress ##NEEDED') >= 0, yList);
check('FM exceptions not processed → ##FM_SUBRC_OK on both identical CALL FUNCTIONs (lines 23 and 27)',
  yAt(23).indexOf('suppress ##FM_SUBRC_OK') >= 0 && yAt(27).indexOf('suppress ##FM_SUBRC_OK') >= 0, yList);
// ATC confirms the source rules for the syntax warnings (class resolved from W247 / W251); their atcFix covers the rest
check('CLIENT SPECIFIED with a client condition → USING CLIENT rewrite (safe), confirmed by ATC',
  yAt(34).indexOf('rewrite client-specified-obsolete') >= 0, yList);
check('CLIENT SPECIFIED with a dynamic column list of column names → rewrite (the list gets commas)', yAt(41).indexOf('rewrite client-specified-obsolete') >= 0, yList);
check('\'EN\' for a language key → rewrite, confirmed by ATC', yAt(47).indexOf('rewrite language-literal') >= 0, yList);
check('SUBMIT of a missing program → ##NEEDED also without DDIC (ATC decides)', yAt(21).indexOf('suppress ##NEEDED') >= 0, yList);
// A disabled rule fixes nothing, also not what ATC reports: the warnings stay as manual findings (they need an exemption)
const yNoRules = { fixMode: 'auto', disabledRules: ['client-specified-obsolete', 'language-literal'] };
const yOff = Atc.applyAtc(analyze(ySrc, yNoRules), Object.assign({ version: 1 }, Atc.matchAtc(analyze(ySrc, yNoRules), yAtc)), true, yNoRules);
const yOffAt = (line) => yOff.findings.filter((f) => f.line === line - 1);
const yOffList = yOff.findings.map((f) => f.line + 1 + ':' + f.ruleId + ' ' + f.action).join(', ');
check('rules switched off: CLIENT SPECIFIED and the language literal are not rewritten',
  ![34, 41, 47].some((l) => yOffAt(l).some((f) => f.action === 'rewrite')) &&
  !yOff.findings.some((f) => yNoRules.disabledRules.indexOf(f.ruleId) >= 0), yOffList);
check('rules switched off: the ATC warnings stay listed as manual findings with an exemption',
  [34, 41, 47].every((l) => yOffAt(l).some((f) => f.ruleId === 'atc' && f.action === 'manual' && f.exemption)), yOffList);
// A rule that is on but whose source check misses the statement: its atcFix rewrites what ATC reports, under the rule's id
const yOld = { fixMode: 'auto', abapRelease: '7.50' };
const yOldRes = Atc.applyAtc(analyze(ySrc, yOld), Object.assign({ version: 1 }, Atc.matchAtc(analyze(ySrc, yOld), yAtc)), true, yOld);
check('abapRelease 7.50: no source finding, but ATC reports GGC → rewrite client-specified-obsolete (atcFix)',
  !analyze(ySrc, yOld).findings.some((f) => f.ruleId === 'client-specified-obsolete') &&
  yOldRes.findings.some((f) => f.line === 33 && f.ruleId === 'client-specified-obsolete' && f.action === 'rewrite' && f.atc),
  yOldRes.findings.map((f) => f.line + 1 + ':' + f.ruleId + ' ' + f.action).join(', '));
check('ruleFixModes of the rule applies to its atcFix: suppress → manual',
  Atc.applyAtc(analyze(ySrc, Object.assign({ ruleFixModes: { 'client-specified-obsolete': 'suppress' } }, yOld)),
    Object.assign({ version: 1 }, Atc.matchAtc(analyze(ySrc, yOld), yAtc)), true,
    Object.assign({ ruleFixModes: { 'client-specified-obsolete': 'suppress' } }, yOld))
    .findings.some((f) => f.line === 33 && f.ruleId === 'client-specified-obsolete' && f.action === 'manual'));
const zlSrc = ['REPORT y.', 'DATA lt_t TYPE STANDARD TABLE OF ztexts.', "SELECT * FROM ztexts INTO TABLE @lt_t WHERE spras = 'EN'.", ''].join('\n');
const zlAtc = Atc.readAtcDiagnostics([
  adt(3, 'W251', 'Syntax check warning. The type of "\'EN\'" cannot be converted to the type of "SPRAS" Internal message code: MESSAGE GXD'),
]);
const zlRes = Atc.applyAtc(analyze(zlSrc, {}), Object.assign({ version: 1 }, Atc.matchAtc(analyze(zlSrc, {}), zlAtc)), true, {});
check('customer table (not checked from the source): ATC reports GXD → language-literal rewrites \'EN\' → \'E\'',
  zlRes.findings.some((f) => f.ruleId === 'language-literal' && f.action === 'rewrite' && /'E'/.test(f.rewrite.summary)),
  zlRes.findings.map((f) => f.line + 1 + ':' + f.ruleId + ' ' + f.action).join(', '));
const gxdOther = Atc.readAtcDiagnostics([
  adt(3, 'W251', 'Syntax check warning. Some other conversion problem. Internal message code: MESSAGE GXD'),
]);
const gxdRes = Atc.applyAtc(analyze(zlSrc, {}), Object.assign({ version: 1 }, Atc.matchAtc(analyze(zlSrc, {}), gxdOther)), true, {});
check('another GXD message is not taken for the language literal rule',
  !gxdRes.findings.some((f) => f.ruleId === 'language-literal'), gxdRes.findings.map((f) => f.ruleId + ' ' + f.action).join(', '));
// The self-check cannot see a finding only ATC reported: its rewrite is not rejected as "still reported"
const zlPicked = zlRes.findings.filter((f) => f.action === 'rewrite');
const zlRejected = verifyRewrites(zlSrc, zlRes, zlPicked, (t) => analyze(t, {}));
check('self-check keeps the rewrite of a finding only ATC reported', zlPicked.length === 1 && zlRejected.size === 0, [...zlRejected.values()].join());

console.log('\n== Without ATC: the source rules fix the same statements ==');
const srcOnly = analyze(ySrc, { fixMode: 'rewrite', ddic: { get: (n) => (n === 'PROG:RSM51000_ALV' ? null : undefined) } });
const srcIds = (line) => srcOnly.findings.filter((f) => f.startLine <= line - 1 && line - 1 <= f.endLine).map((f) => f.ruleId);
check('UP TO 1 ROWS without ORDER BY → select-up-to-no-order-by', srcIds(11).indexOf('select-up-to-no-order-by') >= 0, srcIds(11).join());
check('OPEN CURSOR … FROM dd09l without WHERE → select-no-where', srcIds(14).indexOf('select-no-where') >= 0, srcIds(14).join());
check('SUBMIT of a program the system does not have (ADT) → submit-missing-program', srcIds(21).indexOf('submit-missing-program') >= 0, srcIds(21).join());
check('SELECT … CLIENT SPECIFIED → client-specified-obsolete (not OPEN CURSOR, which ATC does not warn about)',
  srcIds(34).indexOf('client-specified-obsolete') >= 0 && srcIds(41).indexOf('client-specified-obsolete') >= 0 &&
  srcIds(19).indexOf('client-specified-obsolete') < 0, srcIds(19).join());
check("static SAP table, sprsl = 'EN' → language-literal", srcIds(47).indexOf('language-literal') >= 0, srcIds(47).join());
const srcFixed = applyEditsToText(ySrc, planEdits(srcOnly.lines, srcOnly.comments, srcOnly.findings).edits);
check('without ATC the source fix gives the same statements as with ATC',
  ['    FROM ush02  USING CLIENT @s_pclien', "    WHERE sprsl = 'E'.", '    FROM usr02 USING ALL CLIENTS'].every((l) => srcFixed.split('\n').some((x) => x.indexOf(l) === 0)) &&
  /MEMORY ##NEEDED\./.test(srcFixed) && /UP TO 1 ROWS "#EC CI_NOORDER|"#EC CI_NOORDER/.test(srcFixed), srcFixed);
const noLang = analyze("REPORT z.\nSELECT a FROM zlang INTO TABLE lt WHERE langu = 'EN'.\nSELECT a FROM (lv_tab) INTO TABLE lt WHERE spras = 'EN'.\n", {});
check("customer table (Z*) or dynamic table: 'EN' is not rewritten from the source", !noLang.findings.some((f) => f.ruleId === 'language-literal'));
const noDdic = analyze(ySrc, {});
check('SUBMIT without DDIC information: not reported from the source', !noDdic.findings.some((f) => f.ruleId === 'submit-missing-program'));
check('every finding has its own key', new Set(y.findings.map((f) => f.key)).size === y.findings.length);

const yRw = Atc.applyAtc(analyze(ySrc, { fixMode: 'rewrite' }), yState, true, { fixMode: 'rewrite' });
const yFixed = applyEditsToText(ySrc, planEdits(yRw.lines, yRw.comments, yRw.findings).edits);
const yl = yFixed.split('\n');
check('USING CLIENT @x replaces CLIENT SPECIFIED and the client condition; strict mode lists and @',
  /FROM ush02 {2}USING CLIENT @s_pclien$/.test(yl[33]) && yl[30] === '    SELECT mandt,' && yl[31] === '           bname,' &&
  yl[34] === '    WHERE modda < @s_start' && yl[35] === '    GROUP BY mandt, bname "#EC CI_SUBRC' && yl[36] === '    INTO TABLE @it_ush.',
  yl.slice(30, 37).join(' | '));
check('strict mode: INTO moves behind WHERE / GROUP BY, the line count stays', yl.length === ySrc.split('\n').length, yl.length);

// INTO before FOR ALL ENTRIES and WHERE (USING ALL CLIENTS): INTO must end up last, pseudo comments one per line
const faeSrc = [
  'REPORT y.',
  'DATA it_ush02_tmp TYPE STANDARD TABLE OF ush02.',
  'DATA it_ush02_tmp1 TYPE STANDARD TABLE OF ush02.',
  'START-OF-SELECTION.',
  '  SELECT',
  '        MANDT',
  '        BNAME',
  '        MODDA',
  '          FROM USH02  CLIENT SPECIFIED',
  '          INTO TABLE IT_USH02_TMP1',
  '          FOR ALL ENTRIES IN IT_USH02_TMP',
  '          WHERE MANDT = IT_USH02_TMP-MANDT AND BNAME = IT_USH02_TMP-BNAME AND MODDA = IT_USH02_TMP-MODDA.',
  '  WRITE / sy-subrc.',
  '',
].join('\n');
const faeAtc = Atc.readAtcDiagnostics([
  adt(9, 'W247', 'Syntax check warning. Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED". Internal message code: MESSAGE GGC'),
]);
const faeRes = Atc.applyAtc(analyze(faeSrc, {}), Object.assign({ version: 1 }, Atc.matchAtc(analyze(faeSrc, {}), faeAtc)), true, {});
const faeFixed = applyEditsToText(faeSrc, planEdits(faeRes.lines, faeRes.comments, faeRes.findings).edits).split('\n');
check('CLIENT SPECIFIED with INTO before FOR ALL ENTRIES / WHERE → USING ALL CLIENTS, INTO moved to the end',
  faeFixed[8] === '          FROM USH02  USING ALL CLIENTS' &&
  faeFixed[9].indexOf('          FOR ALL ENTRIES IN @IT_USH02_TMP') === 0 &&
  faeFixed[10].indexOf('          WHERE MANDT = @IT_USH02_TMP-MANDT AND BNAME = @IT_USH02_TMP-BNAME AND MODDA = @IT_USH02_TMP-MODDA') === 0 &&
  /^ {10}INTO TABLE @IT_USH02_TMP1\./.test(faeFixed[11]) && faeFixed.length === faeSrc.split('\n').length &&
  faeFixed[5] === '        MANDT,' && faeFixed[7] === '        MODDA',
  faeFixed.slice(4, 12).join(' | '));
check('no single client condition → USING ALL CLIENTS; the literal of the dynamic column list gets commas',
  yl[37] === "    lv_cols = 'GLTGB, USTYP, BNAME' ##NO_TEXT." && yl[40] === '    FROM usr02 USING ALL CLIENTS' && yl[41] === '    INTO TABLE @it_usr',
  yl.slice(37, 42).join(' | '));
check("sprsl = 'EN' → sprsl = 'E'", yl[46] === "    WHERE sprsl = 'E'.", yl[46]);
const ecs = [yl[10], yl[11]].map((l) => (l.match(/"#EC \w+/g) || []).join());
check('one pseudo comment per line on the SELECT with two findings',
  ecs.slice().sort().join('|') === '"#EC CI_ALL_FIELDS_NEEDED|"#EC CI_NOORDER', yl.slice(10, 12).join(' | '));
check('pragmas go before the period', /OTHERS {5}= 2 ##FM_SUBRC_OK\.$/.test(yl[25]) && /MEMORY ##NEEDED\.$/.test(yl[21]), yl[21] + ' | ' + yl[25]);
const yAgain = Atc.applyAtc(analyze(yFixed, { fixMode: 'rewrite' }), yState, false, { fixMode: 'rewrite' });
check('after the fix nothing ATC reported is left', !yAgain.findings.some((f) => f.atc), yAgain.findings.map((f) => f.line + 1 + ':' + f.ruleId).join());

console.log('\n== After a fix in ATC mode: what is left keeps its ATC status, key and line ==');
// The editor reports the changes of one edit from the end backward; trackChanges follows them as VS Code does
const track = (st, edits) => {
  const s2 = Object.assign({}, st, { lineMap: null });
  Atc.trackChanges(s2, edits.slice().sort((a, b) => b.line - a.line || b.col - a.col).map((e) => ({ start: e.line, end: e.endLine, text: e.text })));
  return s2;
};
const shownLine = (f) => (f.line != null ? f.line : f.startLine) + 1;
function partialFix(src, st, opts, pick) {
  const before = Atc.applyAtc(analyze(src, opts), st, true, opts);
  const chosen = before.findings.filter(pick);
  const plan = planEdits(before.lines, before.comments, chosen);
  const out = applyEditsToText(src, plan.edits);
  const after = Atc.applyAtc(analyze(out, opts), track(st, plan.edits), false, opts);
  return { before, chosen, plan, out, after };
}
const pf = partialFix(ySrc, yState, yOpts, (f, i) => i % 2 === 0);
const left = pf.before.findings.filter((f) => pf.chosen.indexOf(f) < 0 || f.action === 'manual');
check('partial fix: exactly the findings not fixed are left, with the same keys (sidebar checkboxes stay)',
  pf.after.findings.map((f) => f.key).sort().join('|') === left.map((f) => f.key).sort().join('|'),
  pf.after.findings.map((f) => shownLine(f) + ':' + f.ruleId).join(', '));
check('partial fix: what is left is shown on the same lines',
  pf.after.findings.every((f) => shownLine(f) === shownLine(left.find((x) => x.key === f.key))),
  pf.after.findings.map((f) => shownLine(f) + ':' + f.ruleId).join(', '));
check('partial fix: the preview of what is left still has changes',
  planEdits(pf.after.lines, pf.after.comments, pf.after.findings).edits.length > 0);
const full = partialFix(ySrc, yState, yOpts, () => true);
check('a pragma added (SUBMIT … ##NEEDED) does not bring back "#EC CI_SUBMIT, which ATC did not report',
  !full.after.findings.some((f) => f.ruleId === 'submit-report'), full.after.findings.map((f) => shownLine(f) + ':' + f.ruleId).join(', '));
const faeFull = partialFix(faeSrc, Object.assign({ version: 1 }, Atc.matchAtc(analyze(faeSrc, {}), faeAtc)), {}, () => true);
check('a rewritten statement (USING ALL CLIENTS) does not bring up findings ATC did not report (CI_FAE_LINES_ENSURED)',
  faeFull.after.findings.length === 0, faeFull.after.findings.map((f) => shownLine(f) + ':' + f.ruleId).join(', '));

// A fix that breaks a line (two pseudo comments on a one-line statement): the lines after it move down by one
const oneSrc = ySrc.replace("ROWS\nWHERE tabname", 'ROWS WHERE tabname');
const oneDiags = yDiags.map((d) => (d.range.start.line > 10 ? Object.assign({}, d, { range: { start: { line: d.range.start.line - 1 } } }) : d));
const oneAtc = Atc.readAtcDiagnostics(oneDiags);
const oneState = Object.assign({ version: 1 }, Atc.matchAtc(analyze(oneSrc, yOpts), oneAtc));
const shift = partialFix(oneSrc, oneState, yOpts, (f) => f.startLine === 10);
const shiftLeft = shift.before.findings.filter((f) => f.startLine !== 10);
check('line break inserted by the fix: one more line', shift.out.split('\n').length === oneSrc.split('\n').length + 1);
check('line break inserted by the fix: every finding after it is shown one line further down',
  shift.after.findings.length === shiftLeft.length &&
  shift.after.findings.every((f) => shownLine(f) === shownLine(shiftLeft.find((x) => x.key === f.key)) + 1),
  shift.after.findings.map((f) => shownLine(f) + ':' + f.ruleId).join(', '));

// Lines shift (another version): each of two identical statements keeps its own finding and line
const yShift = Atc.applyAtc(analyze('* new line\n' + ySrc, yOpts), yState, false, yOpts);
const fm = yShift.findings.filter((f) => f.ruleId === 'fm-subrc-not-checked').map((f) => f.line + 1);
check('identical statements after lines shift: one finding each, on its own line (24, 28)', fm.join() === '24,28', fm.join());

console.log('\n== W126 and buffered tables ==');
const w126Src = [
  'REPORT y.',
  'DATA lt TYPE STANDARD TABLE OF ekko.',
  'DATA l_bukrs TYPE bukrs.',
  'START-OF-SELECTION.',
  '  SELECT a~ebeln e~text1 INTO CORRESPONDING FIELDS OF TABLE lt FROM ekko AS a',
  '    INNER JOIN t052u AS e ON a~zterm = e~zterm',
  '    WHERE a~bukrs = l_bukrs',
  '      AND a~mandt = sy-mandt.',
  '  IF sy-subrc <> 0. ENDIF.',
  '',
].join('\n');
const w126Atc = Atc.readAtcDiagnostics([
  adt(8, 'W126', 'Syntax check warning. The client field "MANDT" cannot be specified in the WHERE condition. Client handling is performed by the compiler. Internal message code: MESSAGE GYA'),
]);
const w126 = Atc.applyAtc(analyze(w126Src, {}), Object.assign({ version: 1 }, Atc.matchAtc(analyze(w126Src, {}), w126Atc)), true, {});
check('W126 (client field in WHERE) → client-field-in-where rewrite, confirmed by ATC',
  w126.findings.some((f) => f.ruleId === 'client-field-in-where' && f.action === 'rewrite' && f.line === 7),
  w126.findings.map((f) => (f.line != null ? f.line + 1 : f.startLine + 1) + ':' + f.ruleId + ' ' + f.action).join(', '));
check('no built-in list of buffered tables: without ATC and without the setting, a JOIN is not reported',
  !analyze(w126Src, {}).findings.some((f) => f.ruleId === 'buffered-table-join'));
check('a table ATC reported as buffered (remembered per system) → "#EC CI_BUFFJOIN',
  analyze(w126Src, { bufferedTables: ['T052U'] }).findings.some((f) => f.ruleId === 'buffered-table-join' && f.token === '"#EC CI_BUFFJOIN'));
check('abap-smartfix.bufferedTables adds tables of your own',
  analyze(w126Src.replace(/t052u/g, 'zmy_table'), { bufferedTables: ['ZMY_TABLE'] }).findings.some((f) => f.ruleId === 'buffered-table-join'));

console.log('\n== More ATC messages and CLIENT SPECIFIED forms ==');
const moreSrc = [
  'REPORT y.',                                                                               // 1
  'TABLES usr02.',                                                                           // 2
  'DATA lv_bname TYPE xubname.',                                                             // 3
  'DATA lv_class TYPE xuclass.',                                                             // 4
  'DATA lt_ush TYPE STANDARD TABLE OF ush02.',                                               // 5
  'FIELD-SYMBOLS <fs_usr02> TYPE usr02.',                                                    // 6
  'START-OF-SELECTION.',                                                                     // 7
  "  SELECT SINGLE * FROM tstc INTO @DATA(ls_tstc) WHERE tcode = 'SU01'.",                    // 8
  '  SELECT SINGLE * FROM usr02 CLIENT SPECIFIED WHERE bname = lv_bname.',                  // 9
  '  SELECT SINGLE bname class FROM usr02 CLIENT SPECIFIED INTO (lv_bname, lv_class)',       // 10
  '    WHERE bcode = space.',                                                                // 11
  '  SELECT * FROM ush02 CLIENT SPECIFIED INTO TABLE lt_ush WHERE bname = gv_other.',        // 12
  '  IF <fs_usr02>-bcode = space.',                                                          // 13
  '  ENDIF.',                                                                                // 14
  '',
].join('\n');
const moreAtc = Atc.readAtcDiagnostics([
  adt(8, '0051', 'Access to single record buffered table TSTC cannot use buffer'),
  adt(9, '0006', 'SELECT on client-specific table USR02 with CLIENT SPECIFIED, but no client field in the WHERE condition'),
  adt(9, 'W247', 'Syntax check warning. Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED". Internal message code: MESSAGE GGC'),
  adt(10, 'W247', 'Syntax check warning. Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED". Internal message code: MESSAGE GGC'),
  adt(12, 'W247', 'Syntax check warning. Use the addition "USING CLIENT" instead of "CLIENT SPECIFIED". Internal message code: MESSAGE GGC'),
  adt(13, 'BOOL', 'Value SPACE is not a valid comparison value for <FS_USR02>-BCODE (type X). The condition "<FS_USR02>-BCODE = SPACE" is never met.'),
  adt(12, 'NOTR', 'SELECT * FOR ALL statement can be joined with SELECT statement at Include Y line 8'),
]);
const moreOpts = { fixMode: 'auto' };
const moreRes = Atc.applyAtc(analyze(moreSrc, moreOpts), Object.assign({ version: 1 }, Atc.matchAtc(analyze(moreSrc, moreOpts), moreAtc)), true, moreOpts);
const moreAt = (line) => moreRes.findings.filter((f) => f.line === line - 1).map((f) => f.action + ' ' + (f.token || f.ruleId) + (f.detail && /manual:/.test(f.detail) ? ' [' + f.detail + ']' : ''));
const moreList = moreRes.findings.map((f) => (f.line + 1) + ':' + f.action + ' ' + (f.token || f.ruleId)).join(', ');
check('0051 single record buffered table → "#EC CI_SGLSELECT', moreAt(8).indexOf('suppress "#EC CI_SGLSELECT') >= 0, moreList);
check('0006 CLIENT SPECIFIED without client field → "#EC CI_BUFFCLIENT', moreAt(9).indexOf('suppress "#EC CI_BUFFCLIENT') >= 0, moreList);
check('SPACE compared with a type X field → ##BOOL_OK', moreAt(13).indexOf('suppress ##BOOL_OK') >= 0, moreList);
check('SELECT … FOR ALL ENTRIES can be joined → "#EC CI_NO_TRANSFORM', moreAt(12).indexOf('suppress "#EC CI_NO_TRANSFORM') >= 0, moreList);
check('no INTO (TABLES work area), INTO list and SPACE → CLIENT SPECIFIED rewritten',
  moreAt(9).indexOf('rewrite client-specified-obsolete') >= 0 && moreAt(10).indexOf('rewrite client-specified-obsolete') >= 0, moreList);
const moreMan = moreAt(12).find((x) => /client-specified-obsolete/.test(x)) || '';
check('an operand declared elsewhere (gv_other) → manual, with the reason in the sidebar',
  /^manual/.test(moreMan) && /gv_other is not declared/i.test(moreMan), moreMan);
const moreFixed = applyEditsToText(moreSrc, planEdits(moreRes.lines, moreRes.comments, moreRes.findings).edits).split('\n');
check('short form: INTO @usr02 is added at the end',
  /^ {2}SELECT SINGLE \* FROM usr02 USING ALL CLIENTS WHERE bname = @lv_bname INTO @usr02\./.test(moreFixed[8]), moreFixed[8]);
check('INTO list gets @ for each target, SPACE gets @, INTO moves to the end',
  /FROM usr02 USING ALL CLIENTS WHERE bcode = @space/.test(moreFixed[9]) && /INTO \(@lv_bname, @lv_class\)\./.test(moreFixed[10]),
  moreFixed.slice(9, 11).join(' | '));
// With the table's columns from the DDIC, gv_other is no column: a data object declared elsewhere
const ush02 = { category: 'table', keys: ['MANDT', 'BNAME', 'MODDA', 'MODTI'], clientKey: 'MANDT', keysComplete: true, hasIncludes: false,
  fields: ['MANDT', 'BNAME', 'MODDA', 'MODTI', 'MODBE', 'TCODE', 'REPID'] };
const ddicOpts = { fixMode: 'auto', ddic: { get: (n) => (n === 'USH02' ? ush02 : undefined) } };
const ddicRes = Atc.applyAtc(analyze(moreSrc, ddicOpts), Object.assign({ version: 1 }, Atc.matchAtc(analyze(moreSrc, ddicOpts), moreAtc)), true, ddicOpts);
check('with the DDIC columns an operand declared elsewhere is escaped (@gv_other)',
  ddicRes.findings.some((f) => f.line === 11 && f.ruleId === 'client-specified-obsolete' && f.action === 'rewrite' && /@|USING/.test(f.rewrite.summary)),
  ddicRes.findings.filter((f) => f.line === 11).map((f) => f.action + ' ' + f.ruleId).join());
// Dynamic column lists filled by DATA … VALUE and by CONCATENATE … SEPARATED BY space
const dynSrc = [
  'REPORT y.',
  "DATA usr02_columns TYPE string VALUE 'MANDT BNAME GLTGB'.",
  'DATA ush_cols TYPE string.',
  'DATA alias_cols TYPE string.',
  'DATA it_usr02_cc_1 TYPE STANDARD TABLE OF usr02.',
  'DATA it_ush TYPE STANDARD TABLE OF ush02.',
  'START-OF-SELECTION.',
  "  CONCATENATE 'MANDT' 'BNAME' 'MODDA' INTO ush_cols SEPARATED BY space.",
  "  alias_cols = 'BNAME AS NAME'.",
  '  SELECT',
  '        (usr02_columns)',
  '        FROM usr02 CLIENT SPECIFIED "#EC CI_SGLSELECT',
  '        INTO TABLE it_usr02_cc_1. "#EC CI_BUFFCLIENT',
  '  SELECT (ush_cols) FROM ush02 CLIENT SPECIFIED INTO TABLE it_ush.',
  '  SELECT (alias_cols) FROM usr02 CLIENT SPECIFIED INTO TABLE it_usr02_cc_1.',
  '',
].join('\n');
const dyn = analyze(dynSrc, { fixMode: 'auto' });
const dynAt = (line) => dyn.findings.filter((f) => f.ruleId === 'client-specified-obsolete' && f.startLine <= line - 1 && line - 1 <= f.endLine);
check('dynamic column list from DATA … VALUE (column names) → rewrite in auto mode', (dynAt(10)[0] || {}).action === 'rewrite', JSON.stringify(dynAt(10).map((f) => [f.action, f.detail])));
check('dynamic column list from CONCATENATE … SEPARATED BY space → rewrite in auto mode', (dynAt(14)[0] || {}).action === 'rewrite', JSON.stringify(dynAt(14).map((f) => [f.action, f.detail])));
check('an alias in the dynamic list (BNAME AS NAME) is not split into commas: manual, the reason in the sidebar',
  (dynAt(15)[0] || {}).action === 'manual' && /more than column names/.test((dynAt(15)[0] || {}).detail), JSON.stringify(dynAt(15).map((f) => [f.action, f.detail])));
const dynFixed = applyEditsToText(dynSrc, planEdits(dyn.lines, dyn.comments, dyn.findings.filter((f) => f.ruleId === 'client-specified-obsolete')).edits).split('\n');
check('DATA … VALUE and CONCATENATE get commas; the SELECT gets USING ALL CLIENTS and @, pseudo comments stay',
  dynFixed[1] === "DATA usr02_columns TYPE string VALUE 'MANDT, BNAME, GLTGB'." &&
  dynFixed[7] === "  CONCATENATE 'MANDT' 'BNAME' 'MODDA' INTO ush_cols SEPARATED BY `, `." &&
  dynFixed[11] === '        FROM usr02 USING ALL CLIENTS "#EC CI_SGLSELECT' &&
  dynFixed[12] === '        INTO TABLE @it_usr02_cc_1. "#EC CI_BUFFCLIENT',
  [dynFixed[1], dynFixed[7], dynFixed[11], dynFixed[12]].join(' | '));

const tokOpts = { tokenOverrides: { 'atc:ZZ01': '"#EC CI_MY_CHECK' } };
const tokAtc = Atc.readAtcDiagnostics([adt(8, 'ZZ01', 'A message of a custom check')]);
const tokRes = Atc.applyAtc(analyze(moreSrc, tokOpts), Object.assign({ version: 1 }, Atc.matchAtc(analyze(moreSrc, tokOpts), tokAtc)), true, tokOpts);
check('tokenOverrides "atc:<message id>" gives the annotation of an unknown ATC message',
  tokRes.findings.some((f) => f.line === 7 && f.action === 'suppress' && f.token === '"#EC CI_MY_CHECK'));

console.log('\n== SCI message catalog of the reference system (sci-messages.js) ==');
const adtMarker = (id, message) => {
  const a = Atc.readAtcDiagnostics([adt(1, id, message)])[0];
  const m = Atc.markerForAtc(a, {});
  return m.token || (m.exemption ? 'exemption' : '');
};
check('SLIN 1701 text symbol not in the text pool → ##TEXT_POOL',
  adtMarker('1701', 'The text symbol T01 is not defined in the text pool of ZSF_DEMO in the original language E.') === '##TEXT_POOL');
check('SLIN 0600 / 0601 message class → ##MG_MISSING',
  adtMarker('0600', 'The message 999 in the message class ZSF_DEMO does not exist.') === '##MG_MISSING' &&
  adtMarker('0601', 'Number of fields of the message 398 specified using WITH for the message class 00: 1 Number of placeholders in this message: 4 Message: & & & &') === '##MG_MISSING');
check('SELECT * incomplete evaluation (UNCLEAR) → "#EC CI_ALL_FIELDS_NEEDED',
  adtMarker('UNCLEAR', 'Incomplete evaluation. 0.0% of fields used') === '"#EC CI_ALL_FIELDS_NEEDED');
check('a message of a check class no rule names: its annotation from the reference system',
  adtMarker('ATYP_COND', 'Missing handling of ABAP-Type in condition') === '"#EC CI_INT8_OK');
check('the ATC finding of an entry taken from ATC wins over the reference system (0051: CI_SGLSELECT)',
  adtMarker('0051', 'Access to single record buffered table T001 cannot use buffer') === '"#EC CI_SGLSELECT');
{
  const { validToken } = require('../src/rules');
  const bad = require('../src/sci-catalog').filter((m) =>
    (m.pcom && !validToken('"#EC ' + m.pcom)) || (m.pcom_alt && !validToken('"#EC ' + m.pcom_alt)) || (m.pragma && !validToken('##' + m.pragma)) ||
    /^[ZY]/.test(m.clsname) || (!m.code && !m.match) || 'text' in m);
  check('every catalog entry: a plain annotation name, a message code or match, no message text, no customer check class', bad.length === 0,
    bad.slice(0, 3).map((m) => m.clsname + ' ' + m.code).join(', '));
}
check('a message code of many check classes: the rule whose text fits narrows it down (0001 → CL_CI_TEST_SYSUBRC)',
  adtMarker('0001', 'No Handling of SY-SUBRC After Changing Database Statement') === '"#EC CI_SUBRC');
check('a message code of many check classes with different annotations and no fitting rule: not guessed (manual)',
  adtMarker('0001', 'Some message of another check') === '');
check('"program does not exist" of any check class: exemption', adtMarker('0001', 'Program ZSF_DEMO does not exist') === 'exemption');
check('a message text such as "&1" does not stand for an unknown message',
  adtMarker('XYZ', 'Nested SELECT: result of statement at MAIN line 12 used in WHERE') === '');

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
