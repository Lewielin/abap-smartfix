'use strict';

/**
 * Writes SCI-COVERAGE.md: which SCI check classes of tools/sci-classes.txt the rules cover.
 * The mapping comes from the rules themselves (sci.classes), so the document follows the code.
 *
 * Run after changing rules:
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" tools\sci-coverage.js
 */

const fs = require('fs');
const path = require('path');
const { BUILTIN_RULES } = require('../src/finding');

const root = path.join(__dirname, '..');
const classes = fs.readFileSync(path.join(__dirname, 'sci-classes.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** Classes covered only in part, and why */
const PARTIAL = {
  CL_CI_TEST_EXTENDED_CHECK: 'the SLIN messages that can be decided from the source (BREAK-POINT, empty CATCH, unused declarations, text literals, AT in a restricted LOOP, FORM not called, sy-subrc after CALL FUNCTION … EXCEPTIONS); most SLIN checks need the compiler',
  CL_CI_TEST_VALUE_PARAMETER: 'internal tables passed by VALUE to methods declared in the same file; a DDIC table type only when the method body uses it as a table; strings and FORM / function module parameters are not checked',
  CL_CI_TEST_ANALYZE_SELECT_DIA: 'SELECT * on one table whose result is read field by field in this program; the share of fields needs the table definition (ADT) for customer tables',
  CL_CI_TEST_SELECT_TAW_A: 'missing WHERE only; the index messages (CI_NOFIRST, CI_NOFIELD) need the DDIC index definitions',
  CL_CI_TEST_IMUD_TAW_A: 'missing WHERE only; the index messages need the DDIC index definitions',
  CL_CI_TEST_ITAB_PERFORMANCE: 'standard tables; CI_SORTSEQ / CI_HASHSEQ need the table keys',
  CL_CI_TEST_SEQ_ACC_ITAB_NESTED: 'standard tables; sorted / hashed tables need the table keys',
  CL_CI_TEST_NO_ORDER_BY: 'SELECT SINGLE without the full key (visible cases) and results used in an order-dependent way; pool / cluster tables need the DDIC',
  CL_CI_TEST_NO_ORDER_BY_DIA: 'as CL_CI_TEST_NO_ORDER_BY',
  CL_CI_TEST_CRITICAL_STATEMENTS: 'CALL TRANSACTION, SUBMIT, EXEC SQL, kernel calls, SYSTEM-CALL, GENERATE, READ / INSERT / DELETE REPORT, EDITOR-CALL, ROLLBACK WORK',
  CL_CI_TEST_SPEC_CRIT_STMNTS: 'CALL TRANSACTION and SUBMIT',
  CL_CI_TEST_IMUD_TAW_SEC01: 'dynamic table / WHERE and CLIENT SPECIFIED on database changes',
  CL_CI_TEST_SELECT_TAW_SEC01: 'dynamic table / WHERE and CLIENT SPECIFIED',
  CL_CI_TEST_LOOP_AT: 'LOOP AT … INTO with MODIFY … FROM the work area',
  CL_CI_TEST_INTFMETHS_IN_LOOP: 'references typed with an interface declared in the same file',
  CL_CI_TEST_SELECT_TAW_BYBUF: 'a JOIN with a table ATC has reported as buffered in this system, or listed in abap-smartfix.bufferedTables (buffering is in the technical settings, which the source does not show)',
};

/** Variants that behave like another class of the list */
const ALIASES = {
  CL_CI_TEST_EXTENDED_CHECK_BASE: 'CL_CI_TEST_EXTENDED_CHECK',
  CL_CI_TEST_EXTENDED_CHECK_SEC: 'CL_CI_TEST_EXTENDED_CHECK',
  CL_CI_TEST_EXTENDED_CHECK_VERS: 'CL_CI_TEST_EXTENDED_CHECK',
};

/** Classes that custom rules (.abap-smartfix-rules.json) can stand in for */
const CUSTOM = ['CL_CI_TEST_FREE_SEARCH', 'CL_CI_TEST_SEARCH_ABAP_PATTERN', 'CL_CI_TEST_SEARCH_STMT_PATTERN', 'CL_CI_TEST_SEARCH_UNWANTED', 'CL_CI_TEST_SEARCH_WRITE'];

/**
 * Checks that were implemented once and removed because their result could not be confirmed against the SCI message catalog
 * of the reference system: the annotation name is not the one the check accepts, the finding is reported on another statement,
 * the check has no pseudo comment, or it depends on settings of the check variant.
 */
const NOT_CONFIRMED = {
  CL_CI_TEST_ANALYZE_SELECT_HANA: 'as CL_CI_TEST_ANALYZE_SELECT_DIA',
  CL_CI_TEST_DB_OPS_IN_LOOPS: 'calls of routines that access the database: the position and the pseudo comment (read or write) depend on the called code',
  CL_CI_TEST_SELECT_IN_LOOP_HANA: 'obsolete in the reference system (replaced by CL_CI_TEST_DB_OPS_IN_LOOPS)',
  CL_CI_TEST_SELECT_WITH_DELETE: 'DELETE after SELECT: which statement carries the finding is not documented',
  CL_CI_TEST_COMPLEX_WHERE: 'the limits come from the check variant',
  CL_CI_TEST_INTO_FIELD_LIST: 'compares data types (needs the DDIC); its messages have no pseudo comment',
  CL_CI_TEST_ORA_RULE_HINT: 'only the generic pseudo comment NOX',
  CL_CI_TEST_SEARCH_STXH_ACCESS: 'a search check (reports every access to STXH / STXL); only the generic DBACCESS_OK',
  CL_CI_TEST_FIND_RFC_CALLBACKS: 'a search check; its messages have no pseudo comment',
  CL_CI_TEST_FIND_AUTH_CHECKS: 'a search check; its messages have no pseudo comment',
  CL_CI_TEST_FIND_DYN_SQL: 'a search check for ADBC and class usage, not for dynamic Open SQL',
  CL_CI_TEST_APPEND_TO_SORTED: 'INSERT … INTO TABLE is reported as well, so the rewrite would not remove the finding',
  CL_CI_TEST_CALL_TRANS_WITH: 'its messages have no pseudo comment; CALL TRANSACTION is covered through CL_CI_TEST_CRITICAL_STATEMENTS',
  CL_CI_TEST_EMPTY: 'no message with a pseudo comment; empty CATCH is covered through CL_CI_TEST_EXTENDED_CHECK',
  CL_CI_TEST_EMPTY_UNUSED_PROCS: 'only the generic pseudo comment NOX; FORM not called is covered through CL_CI_TEST_EXTENDED_CHECK',
  CL_CI_TEST_ABAP_NAMING: 'the naming conventions come from the check variant',
  CL_CI_TEST_ABAP_NAMING_NEW: 'the naming conventions come from the check variant',
  CL_CI_TEST_GET_ABAP_NAMING: 'the naming conventions come from the check variant',
};

const OUT = [
  [/^CL_CI_TEST_PRETTY_PRINT$/, 'Formatting: what abap-cleaner itself does'],
  [/^CL_CI_TEST_ABAP_DOC_COMMENT$/, 'ABAP Doc: abap-cleaner has "Add missing parameters to ABAP Doc"'],
  [/SELECT_TAW_(?:INT)?BYBUF|IMUD_TAW_INT_A|SELECT_TAW_INT_A/, 'Needs DDIC settings (buffering, indexes)'],
  [/MOVE_PERFORMANCE|SUSP_CONVERSIONS|AUTH_CHECKS_IN_RFC/, 'Needs data types or function module attributes'],
  [/CATEGORY/, 'Category node: groups checks in SCI, not a check itself'],
  [/SAUNIT|AUNIT|DYNAMIC_TESTS/, 'Runs ABAP Unit tests'],
  [/METRIC|COMPLEXITY|HALSTEAD|STATIC_REFS|LOAD_SIZE|STATISTICS/, 'Metrics: reports numbers, nothing to fix'],
  [/SYNTAX|COMPILER|UCCHECK|GENERATE|RESTRICTED|ADMISSIBLE|LANGUAGE_VERSION|CLS_CI|UPGRADE|REMOTE_ABLE|RND$|INT8|TYPE_CODES/, 'Needs the ABAP compiler, release or API release information'],
  [/DDIC|CDS|DCLS|DDLS|DDLX|TABNAMES|TABLE_SETTINGS|FIELD_EXT|S4H_DD|ANNO|USAGE_SQL_VIEW|INA1|SQL1|ESH_/, 'DDIC / CDS objects, not ABAP source'],
  [/CTS_|PACKAGE|APPL_COMP|CUST_MODIFICATIONS|OBJECT_DRTY|ARS_|CODE_CLASSIFICATION|SCA_CLASSIFY|COMPARE_OBJECTS|OBT_TDP|ABAP_CHANGE/, 'Transport / package / repository metadata'],
  [/ODATA|SRVB|SADL|IWBEP|RAP_|BDEF|UI5|FPM|WDY|DYNPRO|USAB|SUI_|\/UI2\/|BSP|SAP_SCRIPT|SICF/, 'UI, service or RAP artifacts'],
  [/AMDP|DBPROC|HANA|SQL_TRACE|FULL_TEXT|ANALYZE_SELECT|POOL_CLUSTER|SCAL_TABLE|S4H_SEARCH_DB_OPS|SEARCH_DB_OPS|S4H_TRAN_LITERALS|LITERALS_CHECK|S4H_WHERE_USED|SAP_QUERY_S4H/, 'Database, runtime or S/4HANA simplification data'],
  [/SCAN|CALL_GRAPH|CROSSREF|OBJECT_USAGE|CHECK_OBJ_USAGE|PROGRAM_DEPENDENCY|PROC_CALLS|SEARCH_OBJECTS|COMP_PROCS|SEARCH_PC_TYPES|SEARCH_RFCDES|FIND_BADI_CALL|INCLUDE$|PROGRAM$/, 'Where-used / repository scan across objects'],
];

const byClass = new Map();
for (const r of BUILTIN_RULES) {
  for (const c of (r.sci && r.sci.classes) || []) {
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(r);
  }
}

function annotationOf(rules) {
  const tokens = [...new Set(rules.filter((r) => r.token).map((r) => '`' + r.token + '`'))];
  return tokens.length ? tokens.join(' ') : 'no annotation (rewrite or manual)';
}

function fixesOf(rules) {
  return rules.some((r) => r.fix) ? 'rewrite + ' : '';
}

const rows = classes.map((c) => {
  const rules = byClass.get(c) || byClass.get(ALIASES[c]);
  if (rules) {
    return {
      c,
      group: PARTIAL[c] || ALIASES[c] ? 'partial' : 'covered',
      rules: rules.map((r) => r.id).join(', '),
      annotation: annotationOf(rules),
      fix: fixesOf(rules),
      note: PARTIAL[c] || PARTIAL[ALIASES[c]] || '',
    };
  }
  if (CUSTOM.indexOf(c) >= 0) return { c, group: 'partial', rules: 'custom rules', annotation: 'your own', fix: '', note: 'regex rules in `.abap-smartfix-rules.json`' };
  if (NOT_CONFIRMED[c]) return { c, group: 'unconfirmed', note: NOT_CONFIRMED[c] };
  const out = OUT.find(([re]) => re.test(c));
  return { c, group: 'out', note: out ? out[1] : 'Application- or object-type-specific check (needs data from the system)' };
});

const LABEL = {
  covered: '✅ Covered',
  partial: '🔷 Partly covered',
  unconfirmed: '⛔ Not covered: result could not be confirmed',
  out: '— Out of scope',
};
const count = (g) => rows.filter((r) => r.group === g).length;

const md = [];
md.push('# SCI / ATC check coverage');
md.push('');
md.push('Generated by `tools/sci-coverage.js` from the rules (`sci.classes`) for the ' + classes.length +
  ' Code Inspector classes of one S/4HANA system (' + rows.filter((r) => /CATEGORY/.test(r.c)).length + ' of them are category nodes).');
md.push('SmartFix for ABAP only reads the source in VS Code, so checks that need the DDIC, the compiler, the repository or runtime data are out of scope.');
md.push('');
md.push(Object.keys(LABEL).map((g) => LABEL[g] + ' ' + count(g)).join(' · '));
md.push('');
md.push('**Annotation names.** Every pseudo comment / pragma below is the one the check\'s own message uses in the SCI message catalog');
md.push('of the reference system (`SCIMESSAGES` of the check class); `test/sci.js` checks each rule against that catalog (`src/sci-catalog.js`).');
md.push('If your system uses other names, set them in `abap-smartfix.tokenOverrides` or run **Learn Annotation Names from Workspace**.');
md.push('Checks whose annotation name, finding position or limits could not be confirmed are not included (see the ⛔ table).');
md.push('');
md.push('**With ATC.** The tables below are about the checks SmartFix for ABAP finds in the source itself. When ATC runs in your SAP system,');
md.push('a finding of any check class, also one marked out of scope here, gets the pseudo comment / pragma its check class and message code');
md.push('use in the catalog (`src/sci-messages.js`, plus the messages seen in ATC results in `src/sci-catalog.js`); a message that cannot be');
md.push('suppressed in the code is listed as a manual fix (exemption). Without a check class in the ATC result, a message code that several');
md.push('check classes use with different annotations is not guessed: it is listed as a manual fix.');
md.push('');
for (const g of ['covered', 'partial']) {
  const list = rows.filter((r) => r.group === g);
  md.push('## ' + LABEL[g] + ' (' + list.length + ')');
  md.push('');
  md.push('| Check class | Rules | Fix | Notes |');
  md.push('|---|---|---|---|');
  for (const r of list) md.push('| `' + r.c + '` | ' + r.rules + ' | ' + r.fix + r.annotation + ' | ' + r.note + ' |');
  md.push('');
}
const unconfirmed = rows.filter((r) => r.group === 'unconfirmed');
md.push('## ' + LABEL.unconfirmed + ' (' + unconfirmed.length + ')');
md.push('');
md.push('| Check class | Why it is not included |');
md.push('|---|---|');
for (const r of unconfirmed) md.push('| `' + r.c + '` | ' + r.note + ' |');
md.push('');
const outList = rows.filter((r) => r.group === 'out');
md.push('## ' + LABEL.out + ' (' + outList.length + ')');
md.push('');
const byWhy = new Map();
for (const r of outList) {
  if (!byWhy.has(r.note)) byWhy.set(r.note, []);
  byWhy.get(r.note).push(r.c);
}
md.push('| Reason | Check classes |');
md.push('|---|---|');
for (const [why, list] of byWhy) md.push('| ' + why + ' (' + list.length + ') | ' + list.map((c) => '`' + c + '`').join(', ') + ' |');
md.push('');

// Rules whose classes are not in the list (typos or checks of other systems)
const unknown = [...byClass.keys()].filter((c) => classes.indexOf(c) < 0);
if (unknown.length) console.warn('Classes named by rules but not in sci-classes.txt: ' + unknown.join(', '));
const stale = Object.keys(NOT_CONFIRMED).filter((c) => byClass.has(c));
if (stale.length) console.warn('Classes in NOT_CONFIRMED that rules cover again: ' + stale.join(', '));

fs.writeFileSync(path.join(root, 'SCI-COVERAGE.md'), md.join('\n'));
console.log(Object.keys(LABEL).map((g) => g + '=' + count(g)).join(' ') + ' total=' + classes.length);
