'use strict';

const { parse } = require('./lexer');
const { tokenName, kindOfToken, validToken } = require('./rules');
const F = require('./finding');
const { buildLoops } = require('./structure');
const { customReplace } = require('./rewrites');
const SX = require('./syntax');

// (?=\s|$) instead of \b: keeps calls such as DO( ) and keywords containing - from being taken as loops
const LOOP_OPEN = /^(LOOP|DO|WHILE|PROVIDE)(?=\s|$)/;
const LOOP_CLOSE = /^(ENDLOOP|ENDDO|ENDWHILE|ENDPROVIDE)(?=\s|$)/;
const DECL_HEAD = /^(?:CLASS-)?(DATA|CONSTANTS|STATICS|TYPES|FIELD-SYMBOLS|RANGES)\s+([\s\S]+)$/i;
const IDENT = /^([A-Za-z_<\/][\w<>\/]*)/;
const IDENT_G = /[A-Za-z_<\/][\w<>\/]*/g;

/**
 * Find real SELECT … ENDSELECT loops: a candidate SELECT must be matched by an ENDSELECT.
 * Unmatched ones (for example SELECT … INTO CORRESPONDING FIELDS OF TABLE, COUNT(*)) are not loops,
 * otherwise every later SELECT in the program would be reported as "inside a loop".
 * @returns {Map<number, number>} SELECT statement index → index of the matching ENDSELECT
 */
function buildSelectLoops(statements) {
  const loops = new Map();
  let stack = [];
  for (let i = 0; i < statements.length; i++) {
    const u = statements[i].upper;
    if (SX.isUnitBoundary(u)) { stack = []; continue; }
    if (/^ENDSELECT(?=\s|$)/.test(u)) {
      if (stack.length) loops.set(stack.pop(), i);
      continue;
    }
    if (SX.isSelectLoopCandidate(u)) stack.push(i);
  }
  return loops;
}

function buildLoopDepth(statements, selectLoops) {
  const depth = new Array(statements.length).fill(0);
  const closers = new Set(selectLoops.values());
  let d = 0;
  for (let i = 0; i < statements.length; i++) {
    const u = statements[i].upper;
    if (SX.isUnitBoundary(u)) d = 0;
    if (LOOP_CLOSE.test(u) || closers.has(i)) d = Math.max(0, d - 1);
    depth[i] = d;
    if (LOOP_OPEN.test(u) || selectLoops.has(i)) d++;
  }
  return depth;
}

const PARAM_SECTION = /^(TABLES|USING|CHANGING|IMPORTING|EXPORTING|RETURNING)$/;
const PARAM_STOP = /^(RAISING|EXCEPTIONS|FOR|REDEFINITION|ABSTRACT|FINAL)$/;
const TYPING_WORD = /^(TYPE|LIKE|STRUCTURE|REF|TO|OF|STANDARD|SORTED|HASHED|ANY|INDEX|TABLE|LINE|RANGE|WITH|DEFAULT|KEY|UNIQUE|NON-UNIQUE|EMPTY|OPTIONAL|PREFERRED|PARAMETER|VALUE|REFERENCE)$/;

/** Parameter names of FORM / METHODS */
function collectParams(words, out) {
  let inSection = false;
  for (let i = 2; i < words.length; i++) {
    const w = words[i].upper;
    if (PARAM_SECTION.test(w)) { inSection = true; continue; }
    if (PARAM_STOP.test(w)) { inSection = false; continue; }
    if (!inSection) continue;
    const vr = w.match(/^(?:VALUE|REFERENCE)\(([^)]+)\)$/);
    if (vr) { out.add(vr[1].toLowerCase()); continue; }
    const prev = words[i - 1].upper;
    if (TYPING_WORD.test(w) || /^(TYPE|LIKE|STRUCTURE|TO|OF|DEFAULT)$/.test(prev)) continue;
    if (/^[A-Z_<\/][\w<>\/]*$/.test(w)) out.add(w.toLowerCase());
  }
}

/**
 * Names (lowercase) of data objects declared in this file: DATA / FIELD-SYMBOLS / PARAMETERS / SELECT-OPTIONS …,
 * inline declarations, FORM / METHOD parameters, and function module interface comments (*").
 * TABLES declares database table work areas and is not included.
 */
function buildLocalNames(statements, lines) {
  const out = new Set();
  const RE_DECL = /^(?:CLASS-)?(?:DATA|STATICS|CONSTANTS|FIELD-SYMBOLS|RANGES|PARAMETERS|PARAMETER|SELECT-OPTIONS)\s+(?:BEGIN\s+OF\s+)?([^\s(]+)/;
  const RE_INLINE = /\b(?:DATA|FINAL|FIELD-SYMBOL)\(\s*([^)\s]+)\s*\)/g;
  for (const s of statements) {
    const m = s.upper.match(RE_DECL);
    if (m) out.add(m[1].toLowerCase());
    let im;
    RE_INLINE.lastIndex = 0;
    while ((im = RE_INLINE.exec(s.upper)) !== null) out.add(im[1].toLowerCase());
    if (/^(?:FORM|METHODS|CLASS-METHODS)\s/.test(s.upper)) collectParams(s.words, out);
  }
  for (const line of lines) {
    const fm = line.match(/^\*"\s+(?:(?:VALUE|REFERENCE)\()?([A-Za-z_\/][\w\/]*)\)?(?:\s|$)/);
    if (fm && !/^(IMPORTING|EXPORTING|CHANGING|TABLES|EXCEPTIONS|RAISING)$/i.test(fm[1])) {
      out.add(fm[1].toLowerCase());
    }
  }
  return out;
}

/**
 * Internal table kinds: name (lowercase) → 'standard' | 'sorted' | 'hashed'.
 * DATA x TYPE tty_x is resolved through the TYPES definition (including chained aliases).
 */
function buildTableKinds(statements) {
  const direct = new Map();
  const alias = new Map();
  const RE = /^(?:CLASS-)?(?:DATA|TYPES|STATICS)\s+([^\s(]+)\s+(?:TYPE|LIKE)\s+(?:(STANDARD|SORTED|HASHED|ANY|INDEX)\s+)?(TABLE|RANGE)\b/;
  const RE_ALIAS = /^(?:CLASS-)?(?:DATA|TYPES|STATICS)\s+([^\s(]+)\s+TYPE\s+([^\s(]+)(?:\s|$)/;
  for (const s of statements) {
    const m = s.upper.match(RE);
    if (m) {
      direct.set(m[1].toLowerCase(), m[2] === 'SORTED' ? 'sorted' : m[2] === 'HASHED' ? 'hashed' : 'standard');
      continue;
    }
    const a = s.upper.match(RE_ALIAS);
    if (a) alias.set(a[1].toLowerCase(), a[2].toLowerCase());
  }
  const kinds = new Map(direct);
  for (const name of alias.keys()) {
    let t = name;
    for (let k = 0; k < 5 && !direct.has(t) && alias.has(t); k++) t = alias.get(t);
    if (direct.has(t)) kinds.set(name, direct.get(t));
  }
  return kinds;
}

/**
 * Whether the statement is a public declaration: PUBLIC / PROTECTED SECTION of a class definition, or inside an interface.
 * These are used from outside, so no reference in this file does not mean unused.
 */
function buildExposed(statements) {
  const out = new Array(statements.length).fill(false);
  let inClass = false;
  let inIntf = false;
  let section = '';
  for (let i = 0; i < statements.length; i++) {
    const u = statements[i].upper;
    const sec = u.match(/^(PUBLIC|PROTECTED|PRIVATE)\s+SECTION\b/);
    if (/^CLASS\s+\S+\s+DEFINITION\b/.test(u) && !/\b(?:DEFERRED|LOAD)\b/.test(u)) { inClass = true; section = ''; }
    else if (/^INTERFACE\s+\S+/.test(u) && !/\b(?:DEFERRED|LOAD)\b/.test(u)) inIntf = true;
    else if (sec) section = sec[1];
    else if (/^ENDCLASS\b/.test(u)) { inClass = false; section = ''; }
    else if (/^ENDINTERFACE\b/.test(u)) inIntf = false;
    out[i] = inIntf || (inClass && (section === 'PUBLIC' || section === 'PROTECTED'));
  }
  return out;
}

/** Whether each statement is between METHOD ... ENDMETHOD (header lines are not allowed in classes) */
function buildInMethod(statements) {
  const out = new Array(statements.length).fill(false);
  let inside = false;
  for (let i = 0; i < statements.length; i++) {
    const u = statements[i].upper;
    if (/^METHOD\b/.test(u)) inside = true;
    out[i] = inside;
    if (/^ENDMETHOD\b/.test(u)) inside = false;
  }
  return out;
}

function buildTokenCounts(statements) {
  const counts = new Map();
  for (const s of statements) {
    let m;
    const text = s.native ? s.text + ' ' + s.native.replace(/:/g, ' ') : s.text;
    IDENT_G.lastIndex = 0;
    while ((m = IDENT_G.exec(text)) !== null) {
      const k = m[0].toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Whether each statement is inside a processing block (FORM / METHOD / FUNCTION / MODULE).
 * Declarations inside a block are local and can only be referenced in this file; others are global.
 */
function buildInBlock(statements) {
  const out = new Array(statements.length).fill(false);
  let inside = false;
  for (let i = 0; i < statements.length; i++) {
    const u = statements[i].upper;
    if (/^(?:FORM|METHOD|FUNCTION|MODULE)\s/.test(u)) inside = true;
    out[i] = inside;
    if (/^END(?:FORM|METHOD|FUNCTION|MODULE)(?=\s|$)/.test(u)) inside = false;
  }
  return out;
}

/**
 * Whether global declarations can be judged "unused" from this file alone:
 * it must be a standalone main program (starting with REPORT / PROGRAM) with no INCLUDE and no dynpro of its own.
 * Global variables of a TOP include are usually used in other includes or screens (dynpro fields),
 * so looking at one file would always produce false ##NEEDED findings.
 */
function isSelfContained(statements) {
  const first = statements[0];
  if (!first || !/^(?:REPORT|PROGRAM)(?=\s|$)/.test(first.upper)) return false;
  return !statements.some((s) =>
    /^INCLUDE\s+(?!STRUCTURE\b|TYPE\b)\S+/.test(s.upper) || /^CALL\s+SCREEN\b/.test(s.upper)
  );
}

/**
 * Find declarations that are never referenced after being declared (extended program check: no read access → ##NEEDED).
 * Global declarations are only judged when isSelfContained; local ones (inside FORM / METHOD …) always are.
 */
function buildUnusedDecl(statements, tokenCounts, exposed, comments) {
  const unused = new Map();
  const inBlock = buildInBlock(statements);
  const checkGlobals = isSelfContained(statements);
  const commented = commentedWords(comments);
  let structDepth = 0;
  for (const s of statements) {
    // MESSAGE … INTO DATA(lv_msg) only to fill sy-msg…: abap-cleaner adds ##NEEDED to the MESSAGE statement
    const im = s.upper.match(/^MESSAGE\b.*\bINTO\s+(?:DATA|FINAL)\(\s*([^)\s]+)\s*\)\s*$/);
    if (im && (tokenCounts.get(im[1].toLowerCase()) || 0) <= 1) {
      unused.set(s.index, { name: im[1].toLowerCase(), msgOnly: true });
      continue;
    }

    const m = s.text.match(DECL_HEAD);
    if (!m) continue;
    if (exposed[s.index]) continue;
    if (!inBlock[s.index] && !checkGlobals) continue;
    const rest = m[2].trim();

    if (/^BEGIN\s+OF\b/i.test(rest)) { structDepth++; continue; }
    if (/^END\s+OF\b/i.test(rest)) { structDepth = Math.max(0, structDepth - 1); continue; }
    if (structDepth > 0) continue;

    const idm = rest.match(IDENT);
    if (!idm) continue;
    const name = idm[1].toLowerCase();
    const count = tokenCounts.get(name) || 0;
    const info = {
      name,
      local: inBlock[s.index],
      constant: /^CONSTANTS$/i.test(m[1]),
      inComments: commented.has(name),
      msgOnly: false,
    };
    if (count <= 1) unused.set(s.index, info);
    else if (count <= 4 && onlyMessageInto(statements, s.index, name)) unused.set(s.index, Object.assign(info, { msgOnly: true }));
  }
  return unused;
}

/** Words (lowercase) of full-line * comments, i.e. commented-out code */
function commentedWords(comments) {
  const out = new Set();
  for (const cm of comments || []) {
    if (!cm || !cm.fullLine || cm.text.charAt(0) !== '*') continue;
    const words = cm.text.match(IDENT_G) || [];
    for (const w of words) out.add(w.toLowerCase());
  }
  return out;
}

/** Whether every other reference to name is the INTO target of a MESSAGE statement (assigned, never read) */
function onlyMessageInto(statements, declIndex, name) {
  const esc = SX.escapeRe(name);
  const any = new RegExp('(?:^|[^\\w<>\\/-])' + esc + '(?![\\w<>\\/])', 'i');
  const into = new RegExp('^MESSAGE\\b.*\\bINTO\\s+' + esc + '\\s*$', 'i');
  let seen = false;
  for (const s of statements) {
    if (s.index === declIndex || !any.test(s.text)) continue;
    if (!into.test(s.text)) return false;
    seen = true;
  }
  return seen;
}

const MAX_CUSTOM_PATTERN = 1000;

function compileCustomRules(customRules) {
  const out = [];
  for (const raw of customRules || []) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.match !== 'string') continue;
    // A token must be a plain annotation; an overly long pattern is not compiled (it runs on every statement)
    if (raw.token && !validToken(raw.token)) continue;
    if (raw.match.length > MAX_CUSTOM_PATTERN || (raw.notMatch && String(raw.notMatch).length > MAX_CUSTOM_PATTERN)) continue;
    const hasReplace = typeof raw.replace === 'string';
    if (!raw.token && !hasReplace) continue;
    // g / y keep a position between calls (RegExp.test would alternate between hits and misses): only i, m, s, u
    const flags = typeof raw.flags === 'string' ? [...new Set(raw.flags.replace(/[^imsu]/g, ''))].join('') : 'i';
    let re;
    try {
      re = new RegExp(raw.match, flags);
    } catch (e) {
      continue;
    }
    let notRe = null;
    if (raw.notMatch) {
      try { notRe = new RegExp(raw.notMatch, flags); } catch (e) { notRe = null; }
    }
    out.push({
      id: raw.id,
      kind: raw.token ? kindOfToken(raw.token) : 'rewrite',
      token: raw.token || '',
      severity: raw.severity || 'information',
      title: raw.title || raw.id,
      why: raw.why || 'Custom rule.',
      enabled: raw.enabled !== false,
      custom: true,
      test: (s) => re.test(s.text) && (!notRe || !notRe.test(s.text)),
      fix: hasReplace
        ? customReplace(re, raw.replace, raw.safety === 'review' ? 'review' : 'safe', raw.title || raw.id)
        : null,
    });
  }
  return out;
}

/** Choose token or altToken according to suppressStyle */
function pickToken(rule, style) {
  if (!rule.token) return '';
  if (!rule.altToken || !style || style === 'rule') return rule.token;
  const want = style === 'pragma' ? 'pragma' : 'pseudo';
  if (kindOfToken(rule.token) === want) return rule.token;
  if (kindOfToken(rule.altToken) === want) return rule.altToken;
  return rule.token;
}

/**
 * The annotation of a rule: abap-smartfix.tokenOverrides (source 'setting'), otherwise the rule's own token (source 'rule').
 * variants: every name that counts as "already annotated" (token, altToken and the overriding name)
 */
function resolveAnnotation(rule, opts) {
  const own = [rule.token, rule.altToken].filter(Boolean).map((t) => tokenName(kindOfToken(t), t));
  // Only a plain annotation: a setting must not be able to write other code into the source
  const override = validToken((opts.tokenOverrides || {})[rule.id]) ? String(opts.tokenOverrides[rule.id]).trim() : '';
  const res = override ? { token: override, source: 'setting' } : { token: pickToken(rule, opts.suppressStyle), source: 'rule' };
  const extra = res.token ? [tokenName(kindOfToken(res.token), res.token)] : [];
  res.variants = own.concat(extra.filter((n) => own.indexOf(n) < 0));
  return res;
}

/**
 * Give each finding a key that survives edits elsewhere in the file (line numbers shift, the statement text does not):
 * rule + statement text + occurrence number. The sidebar uses it to remember which findings are unchecked.
 */
function assignKeys(findings, statements) {
  const seen = new Map();
  for (const f of findings) {
    const base = f.ruleId + '\u0001' + statements[f.stmtIndex].upper.replace(/\s+/g, ' ');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    f.key = base + '\u0001' + n;
  }
}

/**
 * Analyze ABAP source and return the findings, each with its fix
 * (action = rewrite / suppress / manual) and the available rewrite (rewrite).
 *
 * @param {string} text source code
 * @param {object} [options]
 *   options.disabledRules  string[]  rule ids to disable
 *   options.enabledRules   string[]  rule ids to force on (overrides rules that are off by default)
 *   options.tokenOverrides object    { ruleId: token } annotation to use per rule
 *   options.customRules    array     custom rules
 *   options.subrcLookahead number    how many statements to look ahead for sy-subrc (default 3)
 *   options.fixMode        string    auto | rewrite | suppress (default auto)
 *   options.ruleFixModes   object    { ruleId: fixMode } fix mode per rule
 *   options.suppressStyle  string    rule | pragma | pseudo: preferred form when a rule has both
 *   options.ddic           object    DDIC view { get(name) } read from the SAP system (ddic.js), optional
 */
function analyze(text, options) {
  const opts = options || {};
  const parsed = parse(text);
  const statements = parsed.statements;

  const tokenCounts = buildTokenCounts(statements);
  const selectLoops = buildSelectLoops(statements);
  const ctx = {
    statements,
    lines: parsed.lines,
    comments: parsed.comments,
    selectLoops,
    loopDepth: buildLoopDepth(statements, selectLoops),
    loops: buildLoops(statements, selectLoops),
    inBlock: buildInBlock(statements),
    inMethod: buildInMethod(statements),
    localNames: buildLocalNames(statements, parsed.lines),
    tableKinds: buildTableKinds(statements),
    tokenCounts,
    unusedDecl: buildUnusedDecl(statements, tokenCounts, buildExposed(statements), parsed.comments),
    // DDIC information from the SAP system (ddic.js); null: decide from the source only
    ddic: opts.ddic || null,
    options: opts,
  };

  const allRules = F.BUILTIN_RULES.concat(compileCustomRules(opts.customRules));
  const findings = [];

  for (const rule of allRules) {
    if (!F.ruleEnabled(rule, opts)) continue;

    const ann = resolveAnnotation(rule, opts);
    const chosenToken = ann.token;
    const canSuppress = !!chosenToken;
    const chosenKind = chosenToken ? kindOfToken(chosenToken) : 'rewrite';
    const variants = ann.variants;
    const mode = F.fixModeOf(rule.id, opts);

    for (const s of statements) {
      let hit = false;
      try {
        hit = !!rule.test(s, ctx);
      } catch (e) {
        hit = false;
      }
      if (!hit) continue;

      // Skip if already annotated (either the pragma or the equivalent pseudo comment is accepted).
      const present = F.presentAnnotations(s);
      const annotated = F.isAnnotated(present, variants);
      // ignoreAnnotations: list annotated statements too (used to learn the annotation names a code base already uses)
      if (annotated && !opts.ignoreAnnotations) continue;

      let rewrite = null;
      if (typeof rule.fix === 'function') {
        try {
          rewrite = rule.fix(s, ctx) || null;
        } catch (e) {
          rewrite = null;
        }
      }
      const action = F.decideAction(mode, rewrite, canSuppress);
      let detail = '';
      if (typeof rule.detail === 'function') {
        try {
          detail = rule.detail(s, ctx) || '';
        } catch (e) {
          detail = '';
        }
      }

      findings.push({
        ruleId: rule.id,
        kind: chosenKind,
        token: chosenToken,
        tokenName: canSuppress ? tokenName(chosenKind, chosenToken) : '',
        canSuppress,
        rewrite,
        action,
        fixMode: mode,
        fixLabel: F.fixLabel(action, chosenToken, rewrite),
        title: rule.title,
        detail,
        why: rule.why,
        tokenSource: ann.source,
        sciClasses: (rule.sci && rule.sci.classes) || [],
        severity: rule.severity || 'information',
        custom: !!rule.custom,
        ...F.locationOf(s, parsed.lines),
      });
      if (opts.ignoreAnnotations) {
        const f = findings[findings.length - 1];
        f.annotated = annotated;
        f.present = [...present];
        f.variants = variants;
      }
    }
  }

  findings.sort((a, b) => a.startLine - b.startLine || a.ruleId.localeCompare(b.ruleId));
  assignKeys(findings, statements);
  return { findings, statements, lines: parsed.lines, comments: parsed.comments, selectLoops, localNames: ctx.localNames };
}

/**
 * Every rule with the annotation it would use and how sure that name is (for "Show Rules").
 * @returns {Array<{rule: object, token: string, source: string, enabled: boolean}>}
 */
function describeRules(options) {
  const opts = options || {};
  return F.BUILTIN_RULES.map((rule) => {
    const ann = resolveAnnotation(rule, opts);
    return { rule, token: ann.token, source: ann.source, enabled: F.ruleEnabled(rule, opts) };
  });
}

module.exports = { analyze, describeRules };
