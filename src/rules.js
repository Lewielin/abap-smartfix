'use strict';

/**
 * Rule catalog.
 *
 * Every annotation name (token / altToken) of a rule with sci.classes was checked against the SCI message catalog of an
 * S/4HANA system (SCIMESSAGES of the check classes): it is the pseudo comment / pragma of the message that check reports.
 * Checks whose name could not be confirmed, or whose finding position is not decidable from the source, are not included.
 *
 * kind:
 *   'pseudo' -> pseudo comment, written after the period, e.g.  ... . "#EC CI_SUBRC
 *   'pragma' -> pragma, written before the period, e.g.         ... ##NEEDED.
 *
 * Each rule's token can be overridden with the abap-smartfix.tokenOverrides setting,
 * because different SAP releases / custom ATC checks may use different names.
 *
 * altToken is the other form of the same check (pragma ↔ pseudo comment). If it is already present the
 * statement counts as annotated, and abap-smartfix.suppressStyle chooses which form to prefer.
 *
 * fix(s, ctx) is the code rewrite (see rewrites.js); rules of kind 'rewrite' have no annotation and can only be rewritten.
 *
 * atcFix(s, ctx, atc) rewrites a statement ATC reports the rule's message on when the rule's own test did not find it (the
 * source check covers fewer cases than the syntax check, or needs a setting ATC makes unnecessary). atc is the ATC finding,
 * whose message text can name what to change. A disabled rule fixes nothing, also not through ATC.
 */

const RW = require('./rewrites');
const RWA = require('./rewrites-atc');
const SX = require('./syntax');
const DD = require('./ddic');

const { isDbSelect } = SX;

/**
 * Look ahead n statements to see whether sy-subrc (or an equivalent check) is evaluated.
 * For a SELECT … ENDSELECT loop, look from after the ENDSELECT; the loop body does not count.
 */
function subrcChecked(ctx, i, lookahead) {
  const n = lookahead == null ? 3 : lookahead;
  const from = ctx.selectLoops.has(i) ? ctx.selectLoops.get(i) : i;
  for (let j = from + 1; j <= from + n && j < ctx.statements.length; j++) {
    const u = ctx.statements[j].upper;
    if (/\bSY-(?:SUBRC|DBCNT)\b/.test(u)) return true;
    // A result checked by a condition (IF lt IS INITIAL); not DELETE itab WHERE line IS INITIAL
    const cond = /^(?:IF|ELSEIF|CHECK|WHILE|ASSERT)\b/.test(u) || /\b(?:COND|XSDBOOL|BOOLC)\b/.test(u);
    if (cond && /\bIS\s+(?:NOT\s+)?(?:INITIAL|ASSIGNED|BOUND)\b/.test(u)) return true;
    if (/\b(?:LINES|LINE_EXISTS)\s*\(/.test(u)) return true;
    // A later statement that sets sy-subrc again: a check after it is not for this statement
    if (setsSubrc(ctx.statements[j], ctx) || isFmWithExceptions(u)) return false;
  }
  return false;
}

/** CALL FUNCTION … EXCEPTIONS (without IN UPDATE TASK): sets sy-subrc; without EXCEPTIONS it dumps on an exception instead */
const isFmWithExceptions = (u) =>
  /^CALL\s+FUNCTION\s/.test(u) && /\bEXCEPTIONS\b/.test(u) && !/\bIN\s+UPDATE\s+TASK\b/.test(u);

/** Statements that set sy-subrc and that Code Inspector expects to be checked */
function setsSubrc(s, ctx) {
  const u = s.upper;
  if (isDbSelect(u)) return true;
  if (/^READ\s+TABLE\s/.test(u)) return true;
  if (/^AUTHORITY-CHECK\s/.test(u)) return true;
  if (/^OPEN\s+DATASET\s/.test(u)) return true;
  // CALL TRANSACTION only sets a meaningful sy-subrc with USING (batch input)
  if (/^CALL\s+TRANSACTION\s/.test(u)) return /\bUSING\b/.test(u);
  // CALL FUNCTION … EXCEPTIONS is reported by the extended program check (##FM_SUBRC_OK), see fm-subrc-not-checked
  // Only INSERT / UPDATE / MODIFY / DELETE on database tables; internal table operations, MODIFY SCREEN etc. do not count
  if (/^(?:INSERT|UPDATE|MODIFY|DELETE)\s/.test(u)) return SX.isDbModification(u, ctx.localNames);
  return false;
}

/** ( name ) as written for a dynamic token; ( a = 1 OR b = 2 ) is a regular parenthesized condition */
const DYN_NAME = '\\(\\s*@?[A-Z_\\/][\\w\\/\\-~>]*\\s*\\)';

/** Database access with a dynamic table: SELECT … FROM (lv_tab), UPDATE (lv_tab) …, DELETE FROM (lv_tab) … */
function dynamicTable(u) {
  if (isDbSelect(u)) return new RegExp('\\b(?:FROM|JOIN)\\s*' + DYN_NAME).test(u);
  return new RegExp('^(?:INSERT|UPDATE|MODIFY|DELETE)\\s+(?:FROM\\s+|INTO\\s+)?' + DYN_NAME).test(u);
}

/** Database access with a dynamic WHERE condition: WHERE (lv_where) */
function dynamicWhere(u, ctx) {
  if (!new RegExp('\\bWHERE\\s*' + DYN_NAME).test(u)) return false;
  if (isDbSelect(u)) return true;
  return /^(?:UPDATE|MODIFY|DELETE)\s/.test(u) && SX.isDbModification(u, ctx.localNames);
}

/** Internal table kind (standard / sorted / hashed; '' when no declaration is found in this file) */
function tableKind(ctx, name) {
  const b = SX.baseName(name).replace(/^me->/, '');
  return ctx.tableKinds.get(b) || '';
}

/** Index of the LOOP statement whose body contains statement i directly (not in a nested LOOP), or -1 */
function enclosingLoop(ctx, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const u = ctx.statements[j].upper;
    if (SX.isUnitBoundary(u)) return -1;
    if (/^ENDLOOP(?=\s|$)/.test(u)) depth++;
    else if (/^LOOP(?=\s|$)/.test(u)) {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

/** Whether control levels (AT NEW / AT END OF …) are used between LOOP statement i and its ENDLOOP */
function loopUsesControlLevel(ctx, i) {
  let depth = 0;
  for (let j = i + 1; j < ctx.statements.length; j++) {
    const u = ctx.statements[j].upper;
    if (/^LOOP(?=\s|$)/.test(u)) depth++;
    else if (/^ENDLOOP(?=\s|$)/.test(u)) { if (depth === 0) return false; depth--; }
    else if (depth === 0 && /^AT\s+(?:NEW|END\s+OF|FIRST|LAST)\b/.test(u)) return true;
    if (SX.isUnitBoundary(u)) return false;
  }
  return false;
}

/**
 * The SELECT has no ORDER BY, and the result table is later used in an order-dependent way (with no SORT in between):
 * READ TABLE … BINARY SEARCH, DELETE ADJACENT DUPLICATES, AT NEW / AT END OF inside LOOP.
 * This is what the Code Inspector "SELECT without ORDER BY" check (CI_NOORDER) actually reports;
 * just reading data into an internal table does not need ORDER BY.
 */
function resultUsedOrderDependent(ctx, i) {
  const target = SX.intoTableTarget(ctx.statements[i].upper);
  if (!target) return false;
  const esc = SX.escapeRe(target).toUpperCase();
  const T = '@?' + esc + '(?:\\[\\])?(?=\\s|$)';
  const reSort = new RegExp('^SORT\\s+' + T);
  const reReset = new RegExp('^(?:CLEAR|REFRESH|FREE)\\s+' + T);
  const reRead = new RegExp('^READ\\s+TABLE\\s+' + T);
  const reAdj = new RegExp('^DELETE\\s+ADJACENT\\s+DUPLICATES\\s+FROM\\s+' + T);
  const reLoop = new RegExp('^LOOP\\s+AT\\s+' + T);

  for (let j = i + 1; j < ctx.statements.length; j++) {
    const s = ctx.statements[j];
    const u = s.upper;
    if (SX.isUnitBoundary(u)) return false;
    if (reSort.test(u) || reReset.test(u)) return false;
    if (SX.isSqlSelect(u) && SX.intoTableTarget(u) === target && !/\bAPPENDING\b/.test(u)) return false;
    if (reRead.test(u) && /\bBINARY\s+SEARCH\b/.test(u)) return true;
    if (reAdj.test(u)) return true;
    if (reLoop.test(u) && loopUsesControlLevel(ctx, j)) return true;
  }
  return false;
}

const RULES = [
  {
    id: 'subrc-not-checked',
    sci: { classes: ['CL_CI_TEST_SYSUBRC'], text: /No Handling of SY-SUBRC/i },
    kind: 'pseudo',
    token: '"#EC CI_SUBRC',
    severity: 'warning',
    title: 'sy-subrc not checked',
    why: 'The Code Inspector "SY-SUBRC handling" check reports that sy-subrc is not evaluated after this statement. If no check is needed, add the annotation.',
    enabled: true,
    test: (s, ctx) => setsSubrc(s, ctx) && !subrcChecked(ctx, s.index, ctx.options.subrcLookahead),
  },
  {
    id: 'fm-subrc-not-checked',
    // SLIN_DESC: the obsolete pseudo comments "#EC FB_RC / FB_NORC of this message are replaced by ##FM_SUBRC_OK
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /function module exception|sy-subrc/i, slin: ['FB_RC', 'FB_NORC'] },
    kind: 'pragma',
    token: '##FM_SUBRC_OK',
    severity: 'warning',
    title: 'sy-subrc not checked after CALL FUNCTION … EXCEPTIONS',
    why: 'The extended program check reports a function module call with EXCEPTIONS whose sy-subrc is not evaluated. Check sy-subrc, or add ##FM_SUBRC_OK when the exceptions may be ignored. "#EC CI_SUBRC does not suppress this message and is replaced by ##FM_SUBRC_OK.',
    enabled: true,
    // With the obsolete "#EC FB_RC / FB_NORC, obsolete-pseudo-comment converts it to the same pragma
    test: (s, ctx) =>
      isFmWithExceptions(s.upper) &&
      !s.pseudoComments.some((n) => n === 'FB_RC' || n === 'FB_NORC') &&
      !subrcChecked(ctx, s.index, ctx.options.subrcLookahead),
    fix: (s, ctx) => RW.replacePseudoWithPragma(s, ctx, { CI_SUBRC: '##FM_SUBRC_OK' }),
  },
  {
    id: 'select-no-order-by',
    sci: { classes: ['CL_CI_TEST_NO_ORDER_BY', 'CL_CI_TEST_NO_ORDER_BY_DIA'], text: /ORDER BY/i },
    kind: 'rewrite',
    severity: 'information',
    title: 'SELECT without ORDER BY',
    why: 'The "SELECT without ORDER BY" check reports a SELECT without ORDER BY whose result table is later used in an order-dependent way (READ TABLE … BINARY SEARCH, DELETE ADJACENT DUPLICATES, AT NEW / AT END OF) with no SORT in between. ATC reports it on that later statement (with "#EC CI_SORTED), so SmartFix for ABAP only offers ORDER BY PRIMARY KEY on the SELECT (review); otherwise SORT the table before it is used.',
    enabled: true,
    test: (s, ctx) =>
      isDbSelect(s.upper) &&
      !/^SELECT\s+SINGLE\b/.test(s.upper) &&
      !/\bORDER\s+BY\b/.test(s.upper) &&
      resultUsedOrderDependent(ctx, s.index),
    fix: RW.addOrderByPrimaryKey,
  },
  {
    id: 'select-single',
    sci: { classes: ['CL_CI_TEST_NO_ORDER_BY', 'CL_CI_TEST_NO_ORDER_BY_DIA'], text: /SELECT SINGLE/i },
    kind: 'pseudo',
    token: '"#EC CI_NOORDER',
    altToken: '"#EC WARNOK',
    severity: 'information',
    title: 'SELECT SINGLE (may not use the full primary key)',
    why: 'The "SELECT without ORDER BY" check reports "SELECT SINGLE is possibly not unique" (AMB_SINGLE) when the WHERE does not specify the full primary key with =. Rewrite it as SELECT … UP TO 1 ROWS … ENDSELECT (same semantics), or add "#EC CI_NOORDER when any matching row will do. With an ADT connection the primary key is read from the table definition in the system; without it only visible cases are reported (no WHERE, OR / range comparisons / IN / LIKE …). Set abap-smartfix.selectSingleCheck to all to list every SELECT SINGLE.',
    enabled: true,
    test: (s, ctx) =>
      /^SELECT\s+SINGLE\b/.test(s.upper) &&
      !SX.selectsFromItab(s.upper) &&
      (ctx.options.selectSingleCheck === 'all' || SX.selectSingleNotFullKey(s.upper) ||
        (DD.missingKeyFields(s.upper, ctx.ddic) || []).length > 0),
    detail: (s, ctx) => {
      const missing = DD.missingKeyFields(s.upper, ctx.ddic);
      return missing && missing.length ? 'key fields not in the WHERE: ' + missing.map((k) => k.toLowerCase()).join(', ') : '';
    },
    fix: RW.selectSingleToUpTo,
  },
  {
    id: 'select-no-where',
    sci: { classes: ['CL_CI_TEST_SELECT_TAW_A'], text: /No WHERE condition/i },
    kind: 'pseudo',
    token: '"#EC CI_NOWHERE',
    severity: 'warning',
    title: 'SELECT without WHERE',
    why: 'The "missing WHERE condition" check reports a full table scan risk. For small customizing tables, add the annotation.',
    enabled: true,
    // OPEN CURSOR … FOR SELECT too (ATC reports "Large table DD09L: No WHERE condition" on it)
    test: (s) => (isDbSelect(s.upper) || /^OPEN\s+CURSOR\b.*\bFOR\s+SELECT\b(?![\s\S]*\bFROM\s+@)/.test(s.upper)) && !/\bWHERE\b/.test(s.upper),
  },
  {
    id: 'select-up-to-no-order-by',
    sci: { classes: ['CL_CI_TEST_NO_ORDER_BY', 'CL_CI_TEST_NO_ORDER_BY_DIA'], text: /UP TO .*ROWS without ORDER BY/i },
    kind: 'pseudo',
    token: '"#EC CI_NOORDER',
    severity: 'information',
    title: 'SELECT … UP TO n ROWS without ORDER BY',
    why: 'The "SELECT without ORDER BY" check reports SELECT … UP TO n ROWS without ORDER BY (SEL_UP_TO) on the SELECT itself: which rows are read is not defined. Add ORDER BY when it matters, or "#EC CI_NOORDER when any rows will do (an existence check with UP TO 1 ROWS).',
    enabled: true,
    test: (s) =>
      isDbSelect(s.upper) &&
      !/^SELECT\s+SINGLE\b/.test(s.upper) &&
      /\bUP\s+TO\s+\S+\s+ROWS\b/.test(s.upper) &&
      !/\bORDER\s+BY\b/.test(s.upper),
  },
  {
    id: 'select-in-loop',
    sci: { classes: ['CL_CI_TEST_SELECT_NESTED'], text: /^SELECT.* loop$/i },
    kind: 'pseudo',
    token: '"#EC CI_SEL_NESTED',
    severity: 'warning',
    title: 'SELECT inside a loop',
    why: 'The "nested SELECT / database access in loops" check reports a performance issue. If it cannot be rewritten, add the annotation.',
    enabled: true,
    test: (s, ctx) => isDbSelect(s.upper) && ctx.loopDepth[s.index] > 0,
  },
  {
    id: 'dynamic-sql',
    sci: { classes: ['CL_CI_TEST_SELECT_TAW_SEC01', 'CL_CI_TEST_IMUD_TAW_SEC01'], text: /Dynamic.*Table/i },
    kind: 'pseudo',
    token: '"#EC CI_DYNTAB',
    severity: 'information',
    title: 'Dynamic table name in SQL',
    why: 'The security checks of database access report a dynamically specified table (FROM (lv_tab), UPDATE (lv_tab) …). Add the annotation after making sure the name cannot come from user input.',
    enabled: true,
    test: (s, ctx) => dynamicTable(s.upper, ctx),
  },
  {
    id: 'dynamic-where',
    sci: { classes: ['CL_CI_TEST_SELECT_TAW_SEC01', 'CL_CI_TEST_IMUD_TAW_SEC01'], text: /Dynamic WHERE/i },
    kind: 'pseudo',
    token: '"#EC CI_DYNWHERE',
    severity: 'information',
    title: 'Dynamic WHERE condition in SQL',
    why: 'The security checks of database access report a dynamic WHERE condition (WHERE (lv_where)). Build it safely (CL_ABAP_DYN_PRG, no unescaped user input), then add the annotation.',
    enabled: true,
    // WHERE ( a = 1 OR b = 2 ) is a regular parenthesized condition; it is dynamic only when the parentheses hold a single name
    test: (s, ctx) => dynamicWhere(s.upper, ctx),
  },
  {
    id: 'client-specified',
    sci: { classes: ['CL_CI_TEST_SELECT_TAW_SEC01', 'CL_CI_TEST_IMUD_TAW_SEC01'], text: /Client-Specific/i },
    kind: 'pseudo',
    token: '"#EC CI_CLIENT',
    severity: 'warning',
    title: 'CLIENT SPECIFIED (cross-client access)',
    why: 'The "cross-client access" check reports statements that bypass automatic client handling. If this is intended, add the annotation.',
    enabled: true,
    test: (s) => /\bCLIENT\s+SPECIFIED\b/.test(s.upper),
  },
  {
    id: 'client-specified-obsolete',
    sci: { classes: ['CL_CI_TEST_SYNTAX_CHECK'], text: /"USING CLIENT" instead of "CLIENT SPECIFIED"|MESSAGE GGC/i },
    kind: 'rewrite',
    severity: 'warning',
    title: 'CLIENT SPECIFIED → USING CLIENT',
    why: 'The syntax check warns that CLIENT SPECIFIED is obsolete (MESSAGE GGC, only on SELECT, not on OPEN CURSOR); no pragma or pseudo comment suppresses it. USING CLIENT @x replaces CLIENT SPECIFIED together with the WHERE condition on the client column; without a single client condition USING ALL CLIENTS keeps the same result. USING CLIENT checks the statement in strict mode, so the lists become comma-separated, host variables (also SPACE, ABAP_TRUE, INTO lists) get @, INTO moves to the end, and the short form without INTO gets INTO @dbtab of its TABLES work area (a dynamic column list of column names filled by a literal, DATA … VALUE or CONCATENATE … SEPARATED BY space gets commas too). Joins, subqueries and operands that may be columns (not declared in this file; with ADT logged on the table columns decide) are left for a manual fix, with the reason. Needs abapRelease 7.54 or later; the statements ATC reports it on are rewritten whatever abapRelease says (the system has USING CLIENT when it warns).',
    enabled: true,
    test: (s, ctx) => isDbSelect(s.upper) && /\bCLIENT\s+SPECIFIED\b/.test(s.upper) && RW.releaseAtLeast(ctx, '7.54'),
    fix: (s, ctx) => RWA.clientSpecifiedToUsingClient(s, ctx),
    atcFix: (s, ctx) => RWA.clientSpecifiedToUsingClient(s, ctx),
    // Why a statement is left for a manual fix, shown in the sidebar
    detail: (s, ctx) => {
      const why = RWA.usingClientBlocker(s, ctx);
      return why ? 'manual: ' + why : '';
    },
  },
  {
    id: 'language-literal',
    // MESSAGE GXD is any "cannot be converted" of the syntax check; only the one about a literal is this rule's
    sci: { classes: ['CL_CI_TEST_SYNTAX_CHECK'], text: /^(?=[\s\S]*MESSAGE GXD\b)[\s\S]*cannot be converted to the type of/i },
    kind: 'rewrite',
    severity: 'warning',
    title: 'Language literal does not fit the language key',
    why: 'The syntax check warns that a two-letter literal cannot be converted to a language field (MESSAGE GXD, e.g. spras = \'EN\'); no pragma or pseudo comment suppresses it. A language key (SPRAS, SPRSL, LANGU …) is one character and ABAP truncates \'EN\' to \'E\' at runtime, so writing \'E\' keeps the result. Only Open SQL on static SAP tables is checked from the source (customer tables may define a two-character field; dynamic tables are not checked by the syntax check). The statements ATC reports it on are rewritten from the literal and the field its message names.',
    enabled: true,
    test: (s) => !!RWA.languageLiteralInSql(s),
    fix: (s) => RWA.languageLiteralInSql(s),
    atcFix: (s, ctx, atc) => RWA.languageLiteral(s, ctx, atc),
  },
  {
    id: 'submit-missing-program',
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /\bSUBMIT\b.*does not exist/i },
    kind: 'pragma',
    token: '##NEEDED',
    severity: 'warning',
    title: 'SUBMIT of a program that does not exist',
    why: 'The extended program check reports SUBMIT of a program that does not exist in the system (e.g. a program of another release, called only after checking TRDIR). Add ##NEEDED when the call is guarded. Decided from the SAP system through ABAP Development Tools for VS Code; without it the statement is not reported.',
    enabled: true,
    test: (s, ctx) => {
      const m = s.upper.match(/^SUBMIT\s+([A-Z_\/][\w\/]*)(?=\s|$)/);
      return !!m && !!ctx.ddic && ctx.ddic.get('PROG:' + m[1]) === null;
    },
  },
  {
    id: 'client-field-in-where',
    // The syntax check reports the same as a warning (W126, MESSAGE GYA: "The client field … cannot be specified in the WHERE condition")
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK', 'CL_CI_TEST_SYNTAX_CHECK'], text: /Client field/i },
    kind: 'rewrite',
    severity: 'warning',
    title: 'Client field in the WHERE condition',
    why: 'The extended program check reports a condition on the client field (MANDT) in Open SQL without CLIENT SPECIFIED / USING CLIENT: automatic client handling already restricts to the current client. "… AND mandt = sy-mandt" is removed (same result); a comparison with another value needs a manual fix (USING CLIENT, or remove it).',
    enabled: true,
    test: (s, ctx) =>
      (isDbSelect(s.upper) || (/^(?:UPDATE|DELETE|MODIFY)\s/.test(s.upper) && SX.isDbModification(s.upper, ctx.localNames))) &&
      !/\bCLIENT\s+SPECIFIED\b|\bUSING\s+(?:CLIENT|ALL\s+CLIENTS|CLIENTS)\b/.test(s.upper) &&
      !!RW.clientConditionWords(s),
    fix: RW.removeClientCondition,
  },
  {
    id: 'linear-search',
    sci: { classes: ['CL_CI_TEST_ITAB_PERFORMANCE'], text: /Sequential read on a standard table/i },
    kind: 'pseudo',
    token: '"#EC CI_STDSEQ',
    severity: 'information',
    title: 'Linear search on a standard table',
    why: 'The "linear search in internal tables" check reports READ TABLE ... WITH KEY on a standard table without BINARY SEARCH, or LOOP AT ... WHERE. SORTED / HASHED tables and USING KEY are not reported. For small tables, add the annotation.',
    enabled: true,
    test: (s, ctx) => {
      const u = s.upper;
      // Inside a loop the same access is reported by nested-linear-search
      if (/\bUSING\s+KEY\b/.test(u) || ctx.loops.enclosing[s.index].length) return false;
      let m = u.match(/^READ\s+TABLE\s+(\S+)/);
      if (m) {
        if (!/\bWITH\s+(?:TABLE\s+)?KEY\b/.test(u) || /\bBINARY\s+SEARCH\b/.test(u)) return false;
        return /^(?:standard)?$/.test(tableKind(ctx, m[1]));
      }
      m = u.match(/^LOOP\s+AT\s+(\S+)/);
      if (m && /\bWHERE\b/.test(u) && !/^(?:SCREEN|GROUP)$/.test(m[1])) {
        return /^(?:standard)?$/.test(tableKind(ctx, m[1]));
      }
      return false;
    },
  },
  {
    id: 'call-transaction',
    sci: { classes: ['CL_CI_TEST_CRITICAL_STATEMENTS', 'CL_CI_TEST_SPEC_CRIT_STMNTS'], text: /Call Transaction/i },
    kind: 'pseudo',
    token: '"#EC CI_CALLTA',
    severity: 'information',
    title: 'CALL TRANSACTION',
    why: 'The "critical statements" check reports CALL TRANSACTION: make sure the user may start the transaction (your own AUTHORITY-CHECK), then add the annotation. Statements with WITH AUTHORITY-CHECK are not listed.',
    enabled: true,
    // Since 7.40, WITH AUTHORITY-CHECK checks authorization automatically, so no annotation is needed
    test: (s) => /^CALL\s+TRANSACTION\s/.test(s.upper) && !/\bWITH\s+AUTHORITY-CHECK\b/.test(s.upper),
  },
  {
    id: 'submit-report',
    sci: { classes: ['CL_CI_TEST_CRITICAL_STATEMENTS', 'CL_CI_TEST_SPEC_CRIT_STMNTS'], text: /Executable Program/i },
    kind: 'pseudo',
    token: '"#EC CI_SUBMIT',
    severity: 'information',
    title: 'SUBMIT of another program',
    why: 'The "critical statements" check reports SUBMIT of another program: make sure the user may run it (AUTHORITY-CHECK), then add the annotation.',
    enabled: true,
    test: (s) => /^SUBMIT\b/.test(s.upper),
  },
  {
    id: 'breakpoint',
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /BREAK-POINT statement/i },
    kind: 'pragma',
    token: '##NO_BREAK',
    altToken: '"#EC NOBREAK',
    severity: 'warning',
    title: 'BREAK-POINT left in code',
    why: 'The "BREAK-POINT / BREAK user" check blocks transports. Annotate breakpoints that are kept on purpose with ##NO_BREAK (better: remove them before release).',
    enabled: true,
    // BREAK-POINT ID grp belongs to an activatable checkpoint group (SAAB) and may stay in production code
    test: (s) =>
      (/^BREAK-POINT(?=\s|$)/.test(s.upper) && !/^BREAK-POINT\s+ID\b/.test(s.upper)) ||
      /^BREAK\s+[A-Z_0-9]+$/.test(s.upper),
    fix: RW.commentOutBreakpoint,
  },
  {
    id: 'empty-handler',
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /Exception handling is empty/i },
    kind: 'pragma',
    token: '##NO_HANDLER',
    altToken: '"#EC NO_HANDLER',
    severity: 'warning',
    title: 'Empty CATCH block',
    why: 'An exception is caught without any handling. If it is ignored on purpose, add ##NO_HANDLER.',
    enabled: true,
    test: (s, ctx) => {
      if (!/^CATCH\b/.test(s.upper)) return false;
      const next = ctx.statements[s.index + 1];
      return !!next && /^(ENDTRY|CATCH|CLEANUP)\b/.test(next.upper);
    },
  },
  {
    id: 'at-in-restricted-loop',
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /contains an AT/i },
    kind: 'pragma',
    token: '##LOOP_AT_OK',
    altToken: '"#EC AT_LOOP_WH',
    severity: 'warning',
    title: 'AT NEW / AT END OF in a LOOP with WHERE / FROM / TO',
    why: 'The extended program check reports control level processing (AT NEW, AT END OF, AT FIRST, AT LAST) in a LOOP that does not process the whole table: the control levels are computed from the rows the loop reads, not from the whole table. Loop over the whole table (filter inside the loop) or annotate with ##LOOP_AT_OK when the result is right.',
    enabled: true,
    test: (s, ctx) => {
      if (!/^AT\s+(?:NEW|END\s+OF|FIRST|LAST)(?=\s|$)/.test(s.upper)) return false;
      const l = enclosingLoop(ctx, s.index);
      return l >= 0 && /^LOOP\s+AT\s/.test(ctx.statements[l].upper) && /\b(?:WHERE|FROM|TO)\b/.test(ctx.statements[l].upper);
    },
    detail: (s, ctx) => 'the LOOP in line ' + (ctx.statements[enclosingLoop(ctx, s.index)].startLine + 1),
  },
  {
    id: 'unused-declaration',
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /^(?:Unused fields|Unread fields|Field symbol is not used|Type is not used)/i },
    kind: 'pragma',
    token: '##NEEDED',
    altToken: '"#EC NEEDED',
    severity: 'information',
    title: 'Declared but never used',
    why: 'The "unused variables / types" check reports this declaration (declarations in the PUBLIC / PROTECTED SECTION of classes and in interfaces are not listed). As in abap-cleaner: an unused local variable can be deleted, a constant, a global or a name used in commented-out code is commented out, and a variable only filled by MESSAGE … INTO gets ##NEEDED. If it is kept for interface compatibility or as a reserved field, add ##NEEDED.',
    enabled: true,
    test: (s, ctx) => ctx.unusedDecl.has(s.index),
    fix: RW.commentOutDeclaration,
  },
  {
    id: 'text-literal',
    // The second text is how ADT for VS Code reports the same message (1700)
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /Text element (?:is )?missing in a character string|Strings without text elements are not translated/i },
    kind: 'pragma',
    token: '##NO_TEXT',
    altToken: '"#EC NOTEXT',
    severity: 'information',
    title: 'Text literal without text symbol',
    why: 'The extended program check "text without text symbol" reports literals shown to users that are not linked to a text symbol (text-001 or \'…\'(001)), e.g. an ALV column heading wa_fieldcat-reptext_ddic = \'Created On\'. Use a text symbol if it needs translation; otherwise add ##NO_TEXT. All-uppercase technical names (\'MATNR\', \'ERDAT\') and single characters are not listed.',
    enabled: true,
    test: (s, ctx) => {
      // Literals in these statements are program names, SQL values, memory IDs, GUI statuses… not text to translate
      if (/^(?:SELECT|WITH|OPEN\s+CURSOR|IMPORT|EXPORT|INCLUDE|TYPE-POOLS?|SUBMIT|CALL\s+TRANSACTION|AUTHORITY-CHECK|SET\s+(?:PF-STATUS|TITLEBAR|PARAMETER|CURSOR)|GET\s+PARAMETER|ASSIGN|EXEC\s+SQL|DEFINE)(?=\s|$)/.test(s.upper)) {
        return false;
      }
      if (/^(?:INSERT|UPDATE|MODIFY|DELETE)\s/.test(s.upper) && SX.isDbModification(s.upper, ctx.localNames)) return false;
      return SX.textLiterals(s.text).some(SX.isTranslatableText);
    },
  },
  {
    id: 'form-not-called',
    sci: { classes: ['CL_CI_TEST_EXTENDED_CHECK'], text: /^FORM not called/i },
    kind: 'pragma',
    token: '##CALLED',
    altToken: '"#EC CALLED',
    severity: 'information',
    title: 'FORM not called by PERFORM in this file',
    why: 'If this FORM is called dynamically (PERFORM ... IN PROGRAM) or from outside, add ##CALLED so the check skips it.',
    enabled: false,
    test: (s, ctx) => {
      const m = s.upper.match(/^FORM\s+([A-Z_0-9/]+)/);
      if (!m) return false;
      return (ctx.tokenCounts.get(m[1].toLowerCase()) || 0) <= 1;
    },
  },

  // ------------------------------------------------ obsolete syntax (no annotation available, rewrite only)
  {
    id: 'obsolete-move',
    kind: 'rewrite',
    severity: 'information',
    title: 'Obsolete MOVE … TO',
    why: 'MOVE a TO b is obsolete; use b = a. MOVE a ?TO b becomes b ?= a and MOVE EXACT a TO b becomes b = EXACT #( a ) (as abap-cleaner does).',
    enabled: true,
    test: (s) => /^MOVE\s/.test(s.upper) && !/\bPERCENTAGE\b/.test(s.upper),
    fix: (s, ctx) => RW.moveToAssign(s, ctx) || RW.chainedMoveToAssign(s, ctx),
  },
  {
    id: 'obsolete-arithmetic',
    kind: 'rewrite',
    severity: 'information',
    title: 'Obsolete ADD / SUBTRACT / MULTIPLY / DIVIDE',
    why: 'Arithmetic keywords are obsolete; ADD a TO b becomes b += a (as abap-cleaner does; release 7.54+). With abap-smartfix.abapRelease below 7.54 it becomes b = b + a.',
    enabled: true,
    test: (s) =>
      /^(ADD|SUBTRACT|MULTIPLY|DIVIDE)\s/.test(s.upper) &&
      !/\b(THEN|UNTIL|GIVING|ACCORDING)\b/.test(s.upper),
    fix: RW.arithmeticToAssign,
  },
  {
    id: 'obsolete-compute',
    kind: 'rewrite',
    severity: 'information',
    title: 'Redundant COMPUTE',
    why: 'The COMPUTE keyword is redundant; just write x = ….',
    enabled: true,
    test: (s) => /^COMPUTE\s/.test(s.upper) && !/^COMPUTE\s+EXACT\b/.test(s.upper),
    fix: RW.dropCompute,
  },
  {
    id: 'obsolete-refresh',
    kind: 'rewrite',
    severity: 'information',
    title: 'Obsolete REFRESH',
    why: 'REFRESH itab is obsolete; use CLEAR itab (CLEAR itab[] when a header line cannot be ruled out, with the same semantics).',
    enabled: true,
    test: (s) => /^REFRESH\s/.test(s.upper) && !/\bFROM\b|^REFRESH\s+CONTROL\b/.test(s.upper),
    fix: (s, ctx) => RW.refreshToClear(s, ctx) || RW.chainedRefreshToClear(s, ctx),
  },
  {
    id: 'obsolete-describe-lines',
    kind: 'rewrite',
    severity: 'information',
    title: 'DESCRIBE TABLE … LINES',
    why: 'DESCRIBE TABLE itab LINES n can be written as n = lines( itab ). Not listed when the block evaluates SY-TFILL / SY-TLENG, which lines( ) does not set (as in abap-cleaner).',
    enabled: true,
    test: (s, ctx) => /^DESCRIBE\s+TABLE\s+\S+\s+LINES\s+\S+$/.test(s.upper) && !!RW.describeToLines(s, ctx),
    fix: RW.describeToLines,
  },
  {
    id: 'obsolete-call-method',
    kind: 'rewrite',
    severity: 'information',
    title: 'CALL METHOD (use a functional call)',
    why: 'CALL METHOD obj->m. can be written as obj->m( ).; with parameters, obj->m( EXPORTING … IMPORTING … ), omitting the keyword when there is only EXPORTING; with RECEIVING r = x it becomes x = obj->m( … ) (as abap-cleaner does). Dynamic calls CALL METHOD (name) are not listed.',
    enabled: true,
    // Not officially obsolete syntax, so it is not listed when it cannot be rewritten (chained, multi-line start…)
    test: (s, ctx) =>
      /^CALL\s+METHOD\s+[^\s(]+(?:\s+(?:EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)\b[\s\S]*)?$/.test(s.upper) &&
      !/^CALL\s+METHOD\s+\S*\(/.test(s.upper) &&
      !/\b(?:PARAMETER-TABLE|EXCEPTION-TABLE)\b/.test(s.upper) &&
      !!(RW.callMethodToFunctional(s, ctx) || RW.callMethodWithParams(s, ctx)),
    fix: (s, ctx) => RW.callMethodToFunctional(s, ctx) || RW.callMethodWithParams(s, ctx),
  },
  {
    id: 'obsolete-create-object',
    kind: 'rewrite',
    severity: 'information',
    title: 'CREATE OBJECT (use NEW)',
    why: 'CREATE OBJECT o EXPORTING p = v. can be written as o = NEW #( p = v ).; with TYPE cls, NEW cls( … ). Not rewritten with EXCEPTIONS, AREA HANDLE, a dynamic type, or when the target is read in its own parameter list (as in abap-cleaner).',
    enabled: true,
    test: (s, ctx) =>
      /^CREATE\s+OBJECT\s/.test(s.upper) &&
      !/\b(?:EXCEPTIONS|AREA\s+HANDLE|PARAMETER-TABLE|EXCEPTION-TABLE)\b|\bTYPE\s+\(/.test(s.upper) &&
      !!RW.createObjectToNew(s, ctx),
    fix: RW.createObjectToNew,
  },
  {
    id: 'obsolete-get-reference',
    kind: 'rewrite',
    severity: 'information',
    title: 'GET REFERENCE OF (use REF #)',
    why: 'GET REFERENCE OF a INTO r. can be written as r = REF #( a ).',
    enabled: true,
    test: (s, ctx) => /^GET\s+REFERENCE\s+OF\s/.test(s.upper) && !!RW.getReferenceToRef(s, ctx),
    fix: RW.getReferenceToRef,
  },
  {
    id: 'obsolete-pseudo-comment',
    kind: 'rewrite',
    severity: 'information',
    title: 'Obsolete pseudo comment (use a pragma)',
    why: 'Pseudo comments for the extended program check are obsolete, e.g. "#EC NEEDED should be ##NEEDED and "#EC NOTEXT should be ##NO_TEXT (full SLIN_DESC table, as in abap-cleaner). Only the effective one is converted: "#EC right after the ", one space, code in upper case. Code Inspector "#EC CI_… comments are not affected.',
    enabled: true,
    // Do not convert when the user prefers pseudo comments, to avoid fighting with suppressStyle
    test: (s, ctx) =>
      ctx.options.suppressStyle !== 'pseudo' && !!RW.pseudoToPragma(s, ctx),
    fix: RW.pseudoToPragma,
  },
];

/** Determine the kind from the token text */
function kindOfToken(token) {
  return /^##/.test(String(token).trim()) ? 'pragma' : 'pseudo';
}

/** Name used for matching: CI_XXX for pseudo comments, ##XXX for pragmas */
function tokenName(kind, token) {
  if (kind === 'pseudo') {
    const m = String(token).match(/#EC[ \t]+([A-Za-z_0-9]+)/);
    return m ? m[1].toUpperCase() : String(token).toUpperCase();
  }
  const m = String(token).match(/##[A-Za-z_0-9]+/);
  return m ? m[0].toUpperCase() : String(token).toUpperCase();
}

/**
 * Whether a token from a setting, a custom rules file or learned from the code is a plain annotation: ##NAME (with
 * optional [parameters]) or "#EC NAME. Anything else would be written into the source as it is, so it is not used.
 */
function validToken(token) {
  const t = String(token || '').trim();
  return /^##[A-Za-z0-9_]{1,60}(?:\[[^\]\r\n."']{0,60}\])*$/.test(t) || /^"#EC [A-Za-z0-9_*]{1,60}$/.test(t);
}

module.exports = { RULES, tokenName, kindOfToken, validToken };
