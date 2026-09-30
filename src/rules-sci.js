'use strict';

/**
 * Performance, robustness and security checks that follow SCI / ATC check classes (see SCI-COVERAGE.md).
 *
 * Besides the fields described in rules.js, every rule here says which SCI check it stands for:
 *   sci.classes     SCI check classes this rule follows
 *   sci.text        matches the English text of the message whose pseudo comment is the rule's token
 *   detail(s, ctx)  extra, statement-specific explanation shown with the finding
 * As in rules.js, every token is the pseudo comment of that message in the SCI message catalog of an S/4HANA system.
 */

const SX = require('./syntax');
const RWS = require('./rewrites-sci');

const { isDbSelect, escapeRe: esc } = SX;
const inLoop = (ctx, i) => ctx.loops.enclosing[i].length > 0;

/** detail: which loop the statement is in */
function loopLine(s, ctx) {
  const l = RWS.innermostLoop(ctx, s.index);
  return l >= 0 ? 'inside the loop in line ' + (ctx.statements[l].startLine + 1) : '';
}

// ---------------------------------------------------------------- FOR ALL ENTRIES guard

/**
 * Whether the driver table of FOR ALL ENTRIES is known to be non-empty at statement i:
 * inside IF itab IS NOT INITIAL / lines( itab ) > 0 (or the ELSE of IF itab IS INITIAL), after CHECK itab IS NOT INITIAL,
 * or after IF itab IS INITIAL. RETURN / EXIT / CONTINUE / RAISE … ENDIF.
 */
function faeGuarded(ctx, i, name) {
  const n = esc(name.toUpperCase()) + '(?:\\[\\])?';
  const notEmpty = new RegExp('(?:^|[\\s(])' + n + '\\s+IS\\s+NOT\\s+INITIAL\\b|\\bLINES\\(\\s*' + n + '\\s*\\)\\s*(?:>|<>|GT|NE|>=|GE)\\s*\\d');
  const empty = new RegExp('(?:^|[\\s(])' + n + '\\s+IS\\s+INITIAL\\b|\\bLINES\\(\\s*' + n + '\\s*\\)\\s*(?:=|EQ|<|LT)\\s*[01]\\b');
  const leaves = /^(?:RETURN|EXIT|CONTINUE|RAISE|LEAVE)\b|^MESSAGE\b.*\bTYPE\s+'[EAX]'/;
  const OPEN = /^(?:IF|CASE|LOOP|DO|WHILE|TRY)(?=\s|$)/;
  const CLOSE = /^END(?:IF|CASE|LOOP|DO|WHILE|TRY|SELECT)(?=\s|$)/;
  const closers = [];
  let inElse = false;
  for (let j = i - 1; j >= 0; j--) {
    const st = ctx.statements[j];
    const u = st.upper;
    if (SX.isUnitBoundary(u)) return false;
    if (CLOSE.test(u)) { closers.push(j); continue; }
    if (OPEN.test(u) || ctx.selectLoops.has(j)) {
      if (closers.length) {
        // A closed block before the SELECT: IF itab IS INITIAL. RETURN. ENDIF. also guards it
        const endIdx = closers.pop();
        if (!closers.length && /^IF\b/.test(u) && empty.test(u)) {
          const body = ctx.statements.slice(j + 1, endIdx);
          const firstBranch = body.findIndex((b) => /^(?:ELSE|ELSEIF)\b/.test(b.upper));
          const branch = firstBranch >= 0 ? body.slice(0, firstBranch) : body;
          if (branch.some((b) => leaves.test(b.upper))) return true;
        }
        continue;
      }
      // An enclosing block
      if (/^IF\b/.test(u) && (inElse ? empty.test(u) : notEmpty.test(u))) return true;
      inElse = false;
      continue;
    }
    if (closers.length) continue;
    if (/^ELSEIF\b/.test(u)) { if (!inElse && notEmpty.test(u)) return true; inElse = false; continue; }
    if (/^ELSE\b/.test(u)) { inElse = true; continue; }
    if (/^CHECK\b/.test(u) && notEmpty.test(u)) return true;
  }
  return false;
}

function faeTable(u) {
  const m = u.match(/\bFOR\s+ALL\s+ENTRIES\s+IN\s+@?([^\s]+)/);
  return m ? SX.baseName(m[1]) : '';
}

// ---------------------------------------------------------------- rules

/**
 * Statements of the "critical statements" check (CL_CI_TEST_CRITICAL_STATEMENTS): each message has its own pseudo comment.
 * [rule id, statement, pseudo comment, message text, title]
 */
const CRITICAL = [
  ['critical-exec-sql', /^EXEC\s+SQL(?=\s|$)/, 'CI_EXECSQL', /Native SQL/i, 'Native SQL (EXEC SQL)'],
  ['critical-kernel-call', /^CALL\s+'/, 'CI_CCALL', /System Function/i, 'Call of a kernel function (CALL \'…\')'],
  ['critical-system-call', /^SYSTEM-CALL(?=\s|$)/, 'CI_SYSTEMCALL', /SYSTEM-CALL/i, 'SYSTEM-CALL'],
  ['critical-generate', /^GENERATE\s+SUBROUTINE\s+POOL\b/, 'CI_GENERATE', /GENERATE/i, 'Generated program (GENERATE SUBROUTINE POOL)'],
  ['critical-report-change', /^(?:INSERT|DELETE)\s+REPORT\b/, 'CI_TABL_EXCEPTN', /Write\/delete a report/i, 'Program source changed (INSERT / DELETE REPORT)'],
  ['critical-read-report', /^READ\s+REPORT\b/, 'CI_READ_REP', /Read a report/i, 'Program source read (READ REPORT)'],
  ['critical-editor-call', /^EDITOR-CALL(?=\s|$)/, 'CI_EDITORCALL', /Call Editor/i, 'EDITOR-CALL'],
  ['critical-rollback', /^ROLLBACK\s+WORK(?=\s|\.|$)/, 'CI_ROLLBACK', /ROLLBACK WORK/i, 'ROLLBACK WORK'],
];

function criticalRule([id, re, pcom, text, title]) {
  return {
    id,
    kind: 'pseudo',
    token: '"#EC ' + pcom,
    sci: { classes: ['CL_CI_TEST_CRITICAL_STATEMENTS'], text },
    severity: 'warning',
    title: 'Critical statement: ' + title,
    why: 'The "critical statements" security check reports this statement: it bypasses checks of the ABAP runtime or ends the logical unit of work. Keep it to a minimum and review it; then add "#EC ' + pcom + '.',
    enabled: true,
    test: (s) => re.test(s.upper),
  };
}

const SCI_RULES = [
  {
    id: 'db-change-in-loop',
    kind: 'pseudo',
    token: '"#EC CI_IMUD_NESTED',
    sci: { classes: ['CL_CI_TEST_IMUD_NESTED'], text: /Loop/i },
    severity: 'warning',
    title: 'Database change inside a loop',
    why: 'INSERT / UPDATE / MODIFY / DELETE on a database table inside a loop sends one database call per row. Collect the rows and use the array form (… FROM TABLE itab) after the loop. When the loop only does MODIFY / UPDATE / DELETE dbtab FROM wa, it is rewritten to one array statement (review).',
    enabled: true,
    test: (s, ctx) => /^(?:INSERT|UPDATE|MODIFY|DELETE)\s/.test(s.upper) && SX.isDbModification(s.upper, ctx.localNames) && inLoop(ctx, s.index),
    detail: loopLine,
    fix: RWS.loopToArrayOperation,
  },
  {
    id: 'sort-in-loop',
    kind: 'pseudo',
    token: '"#EC CI_SORTLOOP',
    sci: { classes: ['CL_CI_TEST_SORT_IN_LOOP'], text: /SORT Inside/i },
    severity: 'warning',
    title: 'SORT inside a loop',
    why: 'The table is sorted again on every pass of the loop. When the loop never changes the table, the SORT is moved in front of the loop (review); otherwise sort once after filling the table, or use a SORTED table.',
    enabled: true,
    test: (s, ctx) => /^SORT\s/.test(s.upper) && inLoop(ctx, s.index),
    detail: loopLine,
    fix: RWS.hoistSortBeforeLoop,
  },
  {
    id: 'select-exit',
    kind: 'pseudo',
    token: '"#EC CI_EXIT_SELECT',
    sci: { classes: ['CL_CI_TEST_SELECT_EXIT'], text: /within a SELECT/i },
    severity: 'warning',
    title: 'SELECT … ENDSELECT left with EXIT',
    why: 'The loop reads a whole result set but stops after the first row. With an unconditional EXIT at the end of the loop it is rewritten to SELECT … UP TO 1 ROWS (same rows, sy-subrc and sy-dbcnt); a conditional EXIT usually means the condition belongs in the WHERE.',
    enabled: true,
    test: (s, ctx) => {
      const e = ctx.selectLoops.get(s.index);
      if (e == null) return false;
      for (let j = s.index + 1; j < e; j++) {
        if (ctx.statements[j].upper === 'EXIT' && RWS.innermostLoop(ctx, j) === s.index) return true;
      }
      return false;
    },
    fix: RWS.selectExitToUpTo,
  },
  {
    id: 'select-then-check',
    kind: 'pseudo',
    token: '"#EC CI_CHECK',
    sci: { classes: ['CL_CI_TEST_SELECT_THEN_CHECK'], text: /Subsequent CHECK/i },
    severity: 'warning',
    title: 'CHECK right after SELECT',
    why: 'A CHECK as the first statement of a SELECT loop throws away rows the database already sent. Move the condition into the WHERE clause when it only uses database fields.',
    enabled: true,
    test: (s, ctx) => ctx.selectLoops.has(s.index) && !!ctx.statements[s.index + 1] && /^CHECK\s/.test(ctx.statements[s.index + 1].upper),
  },
  {
    id: 'fae-without-check',
    kind: 'pseudo',
    token: '"#EC CI_FAE_LINES_ENSURED',
    altToken: '"#EC CI_FAE_NO_LINES_OK',
    sci: { classes: ['CL_CI_TEST_FOR_ALL_ENTRIES'], text: /without prior content validation/i },
    severity: 'warning',
    title: 'FOR ALL ENTRIES without checking that the table has rows',
    why: 'With an empty driver table, FOR ALL ENTRIES drops the whole WHERE and reads every row of the database table. Check the table first; the rewrite wraps the SELECT in IF itab IS NOT INITIAL … ENDIF (review: with an empty table the target and sy-subrc now stay as they were). Add the annotation when the table can never be empty.',
    enabled: true,
    test: (s, ctx) => {
      const t = isDbSelect(s.upper) && faeTable(s.upper);
      return !!t && !faeGuarded(ctx, s.index, t);
    },
    detail: (s) => 'driver table ' + faeTable(s.upper),
    fix: RWS.wrapForAllEntries,
  },
  {
    id: 'change-without-where',
    kind: 'pseudo',
    token: '"#EC CI_NOWHERE',
    sci: { classes: ['CL_CI_TEST_IMUD_TAW_A'], text: /No WHERE condition/i },
    severity: 'warning',
    title: 'UPDATE / DELETE on the database without WHERE',
    why: 'UPDATE dbtab SET … or DELETE FROM dbtab without WHERE changes every row of the table (in the current client). Add the annotation only when that is intended.',
    enabled: true,
    test: (s, ctx) => {
      const u = s.upper;
      if (/\bWHERE\b/.test(u)) return false;
      if (/^UPDATE\s+\S+(?:\s+CLIENT\s+SPECIFIED|\s+USING\s+CLIENT\s+\S+)?\s+SET\b/.test(u)) return true;
      return /^DELETE\s+FROM\s+(?!TABLE\b)\S+$/.test(u) && SX.isDbModification(u, ctx.localNames);
    },
  },
  {
    id: 'loop-modify-from-wa',
    kind: 'pseudo',
    token: '"#EC CI_LOOP_INTO_WA',
    sci: { classes: ['CL_CI_TEST_LOOP_AT'], text: /INTO WA with 'MODIFY'/i },
    severity: 'information',
    title: 'LOOP AT … INTO with MODIFY … FROM the work area',
    why: 'Every row is copied into the work area and back with MODIFY. LOOP AT … ASSIGNING <fs> (or REFERENCE INTO) changes the row in place and needs no MODIFY.',
    enabled: true,
    test: (s, ctx) => {
      const m = s.upper.match(/^LOOP\s+AT\s+(\S+)\s+INTO\s+(\S+)/);
      const end = m && ctx.loops.end.get(s.index);
      if (!end) return false;
      const re = new RegExp('^MODIFY\\s+' + esc(SX.baseName(m[1]).toUpperCase()) + '(?:\\[\\])?\\s+FROM\\s+' + esc(SX.baseName(m[2]).toUpperCase()) + '\\b');
      for (let j = s.index + 1; j < end; j++) if (re.test(ctx.statements[j].upper)) return true;
      return false;
    },
  },
  {
    id: 'nested-linear-search',
    kind: 'pseudo',
    token: '"#EC CI_STDSEQ',
    sci: { classes: ['CL_CI_TEST_SEQ_ACC_ITAB_NESTED', 'CL_CI_TEST_ITAB_PERFORMANCE'], text: /STANDARD table inside/i },
    severity: 'warning',
    title: 'Linear search on a standard table inside a loop',
    why: 'READ TABLE … WITH KEY (without BINARY SEARCH) or LOOP AT … WHERE on a standard table inside another loop costs rows × rows. Use a SORTED / HASHED table or a secondary key (USING KEY).',
    enabled: true,
    test: (s, ctx) => {
      const u = s.upper;
      if (!inLoop(ctx, s.index) || /\bUSING\s+KEY\b/.test(u)) return false;
      let m = u.match(/^READ\s+TABLE\s+(\S+)/);
      if (m) {
        if (!/\bWITH\s+KEY\b/.test(u) || /\bBINARY\s+SEARCH\b/.test(u)) return false;
      } else {
        m = u.match(/^LOOP\s+AT\s+(\S+)/);
        if (!m || !/\bWHERE\b/.test(u) || /^(?:SCREEN|GROUP)$/.test(m[1])) return false;
      }
      const kind = ctx.tableKinds.get(SX.baseName(m[1]).replace(/^me->/, '')) || '';
      return kind === '' || kind === 'standard';
    },
    detail: loopLine,
  },
  {
    id: 'interface-call-in-loop',
    kind: 'pseudo',
    token: '"#EC CI_INTF_LOOP',
    sci: { classes: ['CL_CI_TEST_INTFMETHS_IN_LOOP'], text: /Call interface/i },
    severity: 'information',
    title: 'Interface method called inside a loop',
    why: 'The implementation behind an interface is not visible here and may access the database or do other expensive work on every pass. Check the implementations, or call it once outside the loop.',
    enabled: true,
    test: (s, ctx) => {
      if (!inLoop(ctx, s.index)) return false;
      if (/->[A-Z_\/][\w\/]*~[A-Z_][\w]*\(/.test(s.upper)) return true;
      const refs = interfaceRefs(ctx);
      const m = s.upper.match(/(?:^|[\s(=])([A-Z_][\w]*)->[A-Z_][\w]*\(/);
      return !!m && refs.has(m[1].toLowerCase());
    },
  },
  {
    id: 'value-param-table',
    kind: 'pseudo',
    token: '"#EC CI_VALPAR',
    sci: { classes: ['CL_CI_TEST_VALUE_PARAMETER'], text: /internal table and is passed by VALUE/i },
    severity: 'information',
    title: 'Internal table passed by VALUE',
    why: 'The "low-performance parameter transfers" check reports an IMPORTING / EXPORTING / CHANGING parameter that is an internal table passed by VALUE( ): the whole table is copied on each call. ATC reports it on the METHOD statement of the implementation; RETURNING parameters (always by value) are not reported. Pass it by reference (without VALUE( )) or, when the copy is intended, add "#EC CI_VALPAR. A parameter typed with a DDIC table type is recognized from the system with an ADT connection; without it, it is only listed when the method body uses it as a table (LOOP AT, READ TABLE, APPEND, INTO TABLE …).',
    enabled: true,
    test: (s, ctx) => valueTableParams(ctx).has(s.index),
    detail: (s, ctx) => valueTableParams(ctx).get(s.index).map((p) => p.toLowerCase()).join(', '),
  },
  {
    id: 'buffered-table-join',
    kind: 'pseudo',
    token: '"#EC CI_BUFFJOIN',
    sci: { classes: ['CL_CI_TEST_SELECT_TAW_BYBUF'], text: /Buffered table.*JOIN/i },
    severity: 'information',
    title: 'Buffered table in a JOIN (bypasses the table buffer)',
    why: 'The "SELECT statements that bypass the table buffer" check reports a buffered table read in a JOIN: the JOIN always goes to the database. Read the buffered table separately (it then comes from the buffer), or add the annotation. Whether a table is buffered is part of its technical settings, which neither the source nor the ADT table definition shows: the tables ATC has reported as buffered are remembered per system, and abap-smartfix.bufferedTables adds your own.',
    enabled: true,
    // Buffering is part of the technical settings: known from earlier ATC results or the setting (options.bufferedTables)
    test: (s, ctx) => bufferedJoinTables(s, ctx).length > 0,
    detail: (s, ctx) => 'buffered: ' + bufferedJoinTables(s, ctx).map((t) => t.toLowerCase()).join(', '),
  },
  {
    id: 'select-star-existence',
    kind: 'pseudo',
    token: '"#EC CI_ALL_FIELDS_NEEDED',
    sci: { classes: ['CL_CI_TEST_ANALYZE_SELECT_DIA'], text: /Existence check/i },
    severity: 'information',
    title: 'SELECT * as an existence check (no fields used)',
    why: 'The "SELECT * statements" check reports a SELECT * whose result fields are never used, only sy-subrc: all columns are read for nothing. Select a single constant or key field (SELECT SINGLE @abap_true FROM … INTO @DATA(lv_exists) WHERE …), or add the annotation.',
    enabled: true,
    // Only single-row reads: an internal table filled and never read may be used in ways the source does not show
    test: (s, ctx) => {
      const r = selectStarUsage(ctx, s.index);
      return !!r && r.fields.size === 0 && !r.isTable &&
        (/^SELECT\s+SINGLE\b/.test(s.upper) || /\bUP\s+TO\s+1\s+ROWS\b/.test(s.upper) || !/\b(?:INTO|APPENDING)\b/.test(s.upper));
    },
  },
  {
    id: 'select-star-few-fields',
    kind: 'pseudo',
    token: '"#EC CI_ALL_FIELDS_NEEDED',
    sci: { classes: ['CL_CI_TEST_ANALYZE_SELECT_DIA'], text: /can be transformed/i },
    severity: 'information',
    title: 'SELECT * but only a few fields used',
    why: 'The "SELECT * statements" check reports a SELECT * of which only a few fields are used ("Select-Statement can be transformed. …% of fields used"). List those fields instead of *, or add the annotation. With ADT the share is computed from the table definition; without it, only SAP tables (wide by nature) with at most 5 used fields are listed.',
    enabled: true,
    test: (s, ctx) => {
      const r = selectStarUsage(ctx, s.index);
      return !!r && r.fields.size > 0 && fewFields(r, ctx);
    },
    detail: (s, ctx) => {
      const r = selectStarUsage(ctx, s.index);
      return r ? 'fields used: ' + [...r.fields].map((f) => f.toLowerCase()).sort().join(', ') : '';
    },
  },
].concat(CRITICAL.map(criticalRule));

// ---------------------------------------------------------------- SELECT * field usage

const SELECT_STAR_MAX_PERCENT = 20;
const SELECT_STAR_MAX_FIELDS_NO_DDIC = 5;

/**
 * Tables of a database SELECT with JOIN that are known to be buffered: options.bufferedTables, which holds the tables ATC
 * has reported as buffered in this system and the setting abap-smartfix.bufferedTables (upper case)
 */
function bufferedJoinTables(s, ctx) {
  if (!isDbSelect(s.upper) || !/\bJOIN\b/.test(s.upper)) return [];
  const buffered = new Set(((ctx.options && ctx.options.bufferedTables) || []).map((t) => String(t).toUpperCase()));
  if (!buffered.size) return [];
  const out = [];
  const re = /\b(?:FROM|JOIN)\s+([A-Z\/][\w\/]*)/g;
  let m;
  while ((m = re.exec(s.upper)) !== null) {
    if (buffered.has(m[1]) && out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

/** Whether the used fields are "few": share of the table's fields from the DDIC, or a small number for SAP tables */
function fewFields(r, ctx) {
  const dd = ctx.ddic ? ctx.ddic.get(r.table) : undefined;
  if (dd && dd.category === 'table' && !dd.hasIncludes && dd.fieldCount > 0) {
    return (r.fields.size * 100) / dd.fieldCount <= SELECT_STAR_MAX_PERCENT;
  }
  return !/^(?:Z|Y|\/)/.test(r.table) && r.fields.size <= SELECT_STAR_MAX_FIELDS_NO_DDIC;
}

/**
 * Which fields of a SELECT * result are used in this program: { table, fields } (upper case), or null when it cannot be
 * decided or the whole row is used (APPEND wa, MODIFY dbtab FROM wa, passed as a parameter, MOVE-CORRESPONDING …).
 * The result is followed into LOOP AT … INTO / ASSIGNING and READ TABLE … INTO / ASSIGNING; the fields in WHERE,
 * WITH KEY and SORT … BY of those count as used.
 */
function selectStarUsage(ctx, i) {
  if (!ctx._selectStar) ctx._selectStar = new Map();
  if (ctx._selectStar.has(i)) return ctx._selectStar.get(i);
  let r = null;
  try {
    r = analyzeSelectStar(ctx, i);
  } catch (e) {
    r = null;
  }
  ctx._selectStar.set(i, r);
  return r;
}

function analyzeSelectStar(ctx, i) {
  const s = ctx.statements[i];
  const u = s.upper;
  const DD = require('./ddic');
  const table = DD.selectStarTable(u);
  if (!table || !isDbSelect(u) || /\bFOR\s+ALL\s+ENTRIES\b/.test(u)) return null;
  // Screens use TABLES work areas outside the source
  if (ctx.statements.some((x) => /^CALL\s+SCREEN\b/.test(x.upper))) return null;

  let target;
  let isTable = false;
  const into = u.match(/\b(?:INTO|APPENDING)\s+(CORRESPONDING\s+FIELDS\s+OF\s+)?(TABLE\s+)?@?(?:DATA\(\s*([^\s)]+)\s*\)|([^\s(),]+))/);
  if (into) {
    isTable = !!into[2];
    target = into[3] || into[4];
    // CORRESPONDING FIELDS OF a target typed with the table itself moves every field, as a plain INTO does;
    // any other target type decides which fields are read, which the source alone does not show
    if (into[1] && !typedAsTable(ctx, target, table, isTable)) return null;
  } else {
    // No INTO: the TABLES work area of the same name
    const declared = ctx.statements.some((x) => new RegExp('^TABLES\\s+' + esc(table) + '$').test(x.upper));
    if (!declared) return null;
    target = table;
  }
  target = target.replace(/\[\]$/, '');
  if (!/^[A-Z_<\/][\w<>\/]*$/.test(target)) return null;

  const names = new Set([target]);
  const fields = new Set();
  const clauseFields = (text) => {
    for (const m of text.matchAll(/(?:^|[\s(])([A-Z_][\w]*)\s*(?:=|<>|<=|>=|<|>|\bEQ\b|\bNE\b|\bLT\b|\bGT\b|\bLE\b|\bGE\b|\bIN\b|\bIS\b|\bCP\b|\bNP\b|\bCS\b)/g)) {
      if (!/^(?:AND|OR|NOT|WHERE|KEY|WITH|TABLE)$/.test(m[1])) fields.add(m[1]);
    }
  };
  const tableOps = (t) => {
    const T = esc(t) + '(?:\\[\\])?';
    return [
      new RegExp('^LOOP\\s+AT\\s+' + T + '(?=\\s|$)([\\s\\S]*)$'),
      new RegExp('^READ\\s+TABLE\\s+' + T + '(?=\\s|$)([\\s\\S]*)$'),
    ];
  };
  // Row variables of the result table
  if (isTable) {
    for (const x of ctx.statements) {
      for (const re of tableOps(target)) {
        const m = x.upper.match(re);
        if (!m) continue;
        const v = m[1].match(/\b(?:INTO\s+(?:DATA\(\s*([^\s)]+)\s*\)|([^\s(]+))|ASSIGNING\s+(?:FIELD-SYMBOL\(\s*(<[^>]+>)\s*\)|(<[^>]+>)))/);
        if (v) names.add(v[1] || v[2] || v[3] || v[4]);
        const clause = m[1].match(/\b(?:WHERE|WITH\s+(?:TABLE\s+)?KEY)\b([\s\S]*)$/);
        if (clause) clauseFields(clause[1].replace(/\b(?:INTO|ASSIGNING|REFERENCE|TRANSPORTING|BINARY)\b[\s\S]*$/, ''));
      }
    }
  }

  const rowOps = isTable ? tableOps(target) : [];
  for (const x of ctx.statements) {
    if (x.index === i) continue;
    const raw = x.native ? x.upper + ' ' + x.native.toUpperCase() : x.upper;
    if (![...names].some((n) => raw.includes(n))) continue;
    // LOOP AT / READ TABLE on the result: row variable and key fields were taken above
    if (rowOps.some((re) => re.test(x.upper))) continue;
    // Literals are not references ('EKPO' as a text object name)
    const text = raw.replace(/'(?:[^']|'')*'|`(?:[^`]|``)*`/g, "''");
    for (const n of names) {
      const N = esc(n);
      const any = new RegExp('(?:^|[^\\w<>\\/-])' + N + '(?![\\w<>\\/])', 'g');
      let m;
      while ((m = any.exec(text)) !== null) {
        const after = text.slice(m.index + m[0].length);
        const before = text.slice(0, m.index + m[0].length - n.length);
        const comp = after.match(/^-([A-Z_][\w]*)/);
        // TYPE / LIKE ekpo-brtwr and SELECT-OPTIONS … FOR ekpo-ebeln (or FOR ls_ekpo-ebeln) refer to the type, not to the value
        if (comp && /\b(?:TYPE|LIKE|FOR)\s+(?:(?:REF\s+TO|LINE\s+OF|(?:STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF|RANGE\s+OF)\s+)?$/.test(before)) continue;
        if (comp) { fields.add(comp[1]); continue; }
        if (/^~/.test(after) || /\b(?:FROM|JOIN|TABLES|UPDATE|INTO)\s*@?$/.test(before) && n === table) continue;
        // Another SELECT / READ … INTO the same work area overwrites it and reads none of its fields
        if (/^(?:SELECT|READ\s+TABLE)\b/.test(x.upper) && /\bINTO\s*@?$/.test(before)) continue;
        if (isNeutralUse(x.upper, n, fields)) continue;
        return null;
      }
    }
  }
  return { table, fields, isTable };
}

/** Whether target is declared with the database table as its type (DATA itab TYPE [STANDARD] TABLE OF dbtab / DATA wa TYPE dbtab) */
function typedAsTable(ctx, target, table, isTable) {
  const t = String(target || '').replace(/\[\]$/, '');
  const re = new RegExp('^(?:CLASS-)?(?:DATA|STATICS)\\s+' + esc(t) + '\\s+(?:TYPE|LIKE)\\s+' +
    (isTable ? '(?:(?:STANDARD\\s+|SORTED\\s+|HASHED\\s+)?TABLE\\s+OF\\s+)' : '') + esc(table) + '(?=\\s|$)');
  return ctx.statements.some((x) => re.test(x.upper));
}

/** Uses of the whole result that read no field: declarations, CLEAR / FREE, IS INITIAL, lines( ), LOOP / READ on the result */
function isNeutralUse(u, n, fields) {
  const N = esc(n) + '(?:\\[\\])?';
  if (/^(?:CLASS-)?(?:DATA|STATICS|FIELD-SYMBOLS|TABLES|TYPES)\b/.test(u)) return true;
  if (new RegExp('^(?:CLEAR|REFRESH|FREE)\\b[\\s\\S]*(?:^|[\\s:,])' + N + '(?=[\\s,.]|$)').test(u)) return true;
  if (new RegExp('(?:^|[\\s(])' + N + '\\s+IS\\s+(?:NOT\\s+)?(?:INITIAL|ASSIGNED)\\b').test(u)) return true;
  if (new RegExp('\\bLINES\\(\\s*' + N + '\\s*\\)').test(u)) return true;
  if (new RegExp('^(?:LOOP\\s+AT|READ\\s+TABLE)\\s+' + N + '(?=\\s|$)').test(u)) return true;
  const sort = u.match(new RegExp('^SORT\\s+' + N + '(?:\\s+(?:ASCENDING|DESCENDING))?(?:\\s+BY\\s+([\\s\\S]*))?$'));
  if (sort) {
    if (!sort[1]) return false;
    for (const f of sort[1].split(/\s+/)) if (/^[A-Z_][\w]*$/.test(f) && !/^(?:ASCENDING|DESCENDING|AS|TEXT)$/.test(f)) fields.add(f);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- VALUE parameters that are internal tables

const PARAM_KEYWORD = /^(?:IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING|EXCEPTIONS|OPTIONAL|DEFAULT|PREFERRED|ABSTRACT|FINAL|REDEFINITION|FOR|RESUMABLE)$/;

/**
 * VALUE( ) parameters of a METHODS declaration with their typing (upper case), e.g. { name: 'RT_A', typing: 'TYPE TTY_A' }.
 * The typing runs up to the next parameter or keyword.
 */
function valueParamsOf(words) {
  const out = [];
  let section = '';
  for (let i = 2; i < words.length; i++) {
    if (/^(?:IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING|EXCEPTIONS)$/.test(words[i].upper)) section = words[i].upper;
    const m = words[i].upper.match(/^VALUE\(([^)]+)\)$/);
    // RETURNING is always by value and cannot be passed by reference: ATC does not report it
    if (!m || section === 'RETURNING') continue;
    const typing = [];
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j].upper;
      if (/^(?:VALUE|REFERENCE)\(/.test(w) || PARAM_KEYWORD.test(w)) break;
      // Next parameter without VALUE( ): a name followed by TYPE / LIKE, once this typing is complete
      if (typing.length >= 2 && j + 1 < words.length && /^(?:TYPE|LIKE)$/.test(words[j + 1].upper) &&
          !/^(?:TO|OF)$/.test(typing[typing.length - 1])) break;
      typing.push(w);
    }
    out.push({ name: m[1], typing: typing.join(' ') });
  }
  return out;
}

/**
 * Whether a typing is an internal table: 'yes', 'no' or 'unknown' (a type this file does not declare, e.g. a DDIC table type).
 * Types of this file are resolved with ctx.tableKinds (TYPES tty TYPE … TABLE OF / RANGE OF).
 */
function typingIsTable(typing, ctx) {
  if (/^TYPE\s+REF\s+TO\b/.test(typing)) return 'no';
  if (/^(?:TYPE|LIKE)\s+(?:(?:STANDARD|SORTED|HASHED|ANY|INDEX)\s+)?TABLE\b|^(?:TYPE|LIKE)\s+RANGE\s+OF\b|^LIKE\s+LINE\s+OF\b/.test(typing)) {
    return /^LIKE\s+LINE\s+OF\b/.test(typing) ? 'no' : 'yes';
  }
  const m = typing.match(/^(?:TYPE|LIKE)\s+(\S+)$/);
  if (!m) return 'unknown';
  const name = m[1].replace(/^.*=>/, '').toLowerCase();
  if (ctx.tableKinds.has(name)) return 'yes';
  // DDIC object read from the system (ADT): a table type is an internal table, a table / structure is a row
  const dd = !/=>/.test(m[1]) && ctx.ddic ? ctx.ddic.get(m[1]) : undefined;
  if (dd) return dd.category === 'tabletype' ? 'yes' : 'no';
  // Built-in and elementary types, and types of this file that are not tables
  if (/^(?:I|INT8|F|P|C|N|D|T|X|STRING|XSTRING|DECFLOAT16|DECFLOAT34|UTCLONG|ABAP_BOOL|ABAP_BOOLEAN|BOOLEAN|FLAG|SY-\S+|SYST-\S+)$/i.test(name)) return 'no';
  if (ctx.statements.some((s) => new RegExp('^(?:CLASS-)?TYPES\\s+(?:BEGIN\\s+OF\\s+)?' + esc(name.toUpperCase()) + '(?:\\s|$)').test(s.upper))) return 'no';
  return 'unknown';
}

/** Whether the method body (statements from..to) uses name as an internal table */
function usedAsTable(ctx, from, to, name) {
  const n = esc(name) + '(?![\\w\\-~>=])';
  const res = [
    new RegExp('^LOOP\\s+AT\\s+(?:GROUP\\s+)?' + n),
    new RegExp('^READ\\s+TABLE\\s+' + n),
    new RegExp('^(?:APPEND|INSERT|COLLECT)\\b.*\\b(?:TO|INTO)\\s+(?:TABLE\\s+)?' + n + '(?:\\s|$)'),
    new RegExp('^SORT\\s+' + n),
    new RegExp('^DELETE\\s+(?:ADJACENT\\s+DUPLICATES\\s+FROM\\s+|TABLE\\s+)?' + n + '\\s+(?:WHERE|INDEX|FROM|USING|COMPARING)\\b'),
    new RegExp('^MODIFY\\s+(?:TABLE\\s+)?' + n + '\\s+(?:FROM|INDEX|TRANSPORTING)\\b'),
    new RegExp('\\b(?:APPENDING|INTO)\\s+(?:CORRESPONDING\\s+FIELDS\\s+OF\\s+)?TABLE\\s+@?' + n),
    new RegExp('\\b(?:LINES|LINE_EXISTS|LINE_INDEX)\\(\\s*' + n),
    new RegExp('(?:^|[\\s(@])' + esc(name) + '\\[\\s'),
    new RegExp('\\bIN\\s+(?:TABLE\\s+)?' + n + '(?:\\s|$)'),
    new RegExp('^' + n + '\\s*=\\s*VALUE\\s+#\\(\\s*(?:BASE\\s+\\S+\\s+)?\\('),
  ];
  for (let j = from; j <= to; j++) {
    const u = ctx.statements[j].upper;
    if (res.some((re) => re.test(u))) return true;
  }
  return false;
}

/**
 * METHOD statements (index) of implementations whose declaration in this file has internal tables passed by VALUE
 * → names of those parameters. Declarations: METHODS / CLASS-METHODS in CLASS … DEFINITION or INTERFACE (METHOD lif~m).
 */
function valueTableParams(ctx) {
  if (ctx._valueTableParams) return ctx._valueTableParams;
  const decl = new Map(); // 'class|method' → [{ name, typing }]
  let owner = '';
  let implClass = '';
  const impls = [];
  for (const s of ctx.statements) {
    const u = s.upper;
    let m;
    if ((m = u.match(/^CLASS\s+(\S+)\s+DEFINITION\b/)) && !/\b(?:DEFERRED|LOAD)\b/.test(u)) owner = m[1];
    else if ((m = u.match(/^INTERFACE\s+(\S+)$/))) owner = m[1];
    else if ((m = u.match(/^CLASS\s+(\S+)\s+IMPLEMENTATION\b/))) implClass = m[1];
    else if (/^END(?:CLASS|INTERFACE)(?=\s|$)/.test(u)) { owner = ''; implClass = ''; }
    else if (owner && (m = u.match(/^(?:CLASS-)?METHODS\s+(\S+)/))) {
      const params = valueParamsOf(s.words);
      if (params.length) decl.set(owner + '|' + m[1], params);
    } else if (implClass && (m = u.match(/^METHOD\s+(\S+)$/))) impls.push({ index: s.index, cls: implClass, name: m[1] });
  }

  const out = new Map();
  for (const im of impls) {
    const tilde = im.name.indexOf('~');
    const key = tilde > 0 ? im.name.slice(0, tilde) + '|' + im.name.slice(tilde + 1) : im.cls + '|' + im.name;
    const params = decl.get(key);
    if (!params) continue;
    let end = im.index + 1;
    while (end < ctx.statements.length && !/^ENDMETHOD(?=\s|$)/.test(ctx.statements[end].upper)) end++;
    const names = params
      .filter((p) => {
        const t = typingIsTable(p.typing, ctx);
        return t === 'yes' || (t === 'unknown' && usedAsTable(ctx, im.index + 1, end - 1, p.name));
      })
      .map((p) => p.name);
    if (names.length) out.set(im.index, names);
  }
  ctx._valueTableParams = out;
  return out;
}

/** Reference variables typed with an interface (ZIF_…, IF_…, /NS/IF_…): name (lowercase) */
function interfaceRefs(ctx) {
  if (ctx._intfRefs) return ctx._intfRefs;
  const out = new Set();
  for (const s of ctx.statements) {
    const m = s.upper.match(/^(?:CLASS-)?DATA\s+([^\s(]+)\s+TYPE\s+REF\s+TO\s+((?:\/\w+\/)?[ZY]?IF_\w+)/);
    if (m) out.add(m[1].toLowerCase());
  }
  ctx._intfRefs = out;
  return out;
}

module.exports = { SCI_RULES };
