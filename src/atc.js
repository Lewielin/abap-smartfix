'use strict';

/**
 * Use the result of a real ATC run to decide which findings to fix.
 *
 * ATC is run by ABAP Development Tools for VS Code (command adt-vscode.runAtcOnObject), which publishes every finding as a
 * diagnostic: source "ATC", code "<check class> - <message id>", the message text, and the line. Those are matched to the
 * findings of the rules here by line (inside the statement) and SCI check class + message text (rule.sci):
 *   - a finding of a rule with SCI classes that ATC does not report is hidden (the check variant does not contain it);
 *   - an ATC finding no rule produced is rewritten by the enabled rule whose message it is and that has an atcFix (syntax
 *     check warnings no annotation suppresses); otherwise it gets the annotation its check message uses (markerForAtc, as
 *     the check's own GET_MESSAGE_PCOMS: SCI message catalog, pragma first, then the rule, then a ##PRAGMA in the text);
 *     without one it is a manual finding (with "request an exemption" when the message cannot be suppressed);
 *   - findings of rules without SCI classes (modern syntax rewrites, custom rules) are kept as they are.
 * Findings are remembered by their key (rule + statement text), so the decision survives edits until ATC is run again.
 *
 * ADT for VS Code 1.1.x publishes the code as "undefined - <message id>": its ATC result carries no check class. The class is
 * then taken from the messages seen in ATC results whose text fits, or from the check classes with that message code in the
 * SCI message catalog (resolveClasses).
 */

const { tokenName, kindOfToken, validToken } = require('./rules');
const F = require('./finding');

const CATALOG = require('./sci-catalog');

const { BUILTIN_RULES, RULE_BY_ID, hasSciClasses } = F;

/** Check classes of one family report the same messages (…_DIA / _HANA, extended check variants) */
function classFamily(name) {
  return String(name || '').toUpperCase().trim().replace(/_(?:DIA|HANA|BASE|SEC|VERS)$/, '');
}

/**
 * Messages every check class inherits from CL_CI_TEST_ROOT (under the codes 0001 / 0002 of each class): the object could
 * not be checked, which no annotation in the code changes
 */
const ROOT_MESSAGES = [
  { clsname: '', code: '', pcom: 'NOX', pcom_alt: '', pragma: '', match: /^Program \S+ does not exist$/i },
  { clsname: '', code: '', pcom: 'NOX', pcom_alt: '', pragma: '', match: /^Program \S+ is read-protected$/i },
];

/** Whether catalog entry m, a message seen in ATC results, is the message of ATC finding a (by the part of its text in match) */
function textFits(m, a) {
  return !!m.match && m.match.test(a.message.trim());
}

/** How much text an entry's match names: a longer part recognizes a message more surely */
function specificity(m) {
  return m.match ? m.match.source.replace(/\\./g, '').replace(/[^A-Za-z]/g, '').length : 0;
}

/** Whether a message is recognized by its text alone, without its code */
const distinctive = (m) => specificity(m) >= 12;

/** The catalog grouped once: the messages seen in ATC results (with match), and every entry by message code */
let INDEX = null;
function catalogIndex() {
  if (INDEX) return INDEX;
  const byCode = new Map();
  for (const m of CATALOG) {
    const k = String(m.code || '').toUpperCase();
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(m);
  }
  INDEX = { seen: CATALOG.filter((m) => m.match), byCode };
  return INDEX;
}

/** The catalog messages of list that fit finding a with the most specific match */
function mostSpecific(list, a) {
  const fit = list.filter((m) => textFits(m, a));
  const best = Math.max(0, ...fit.map(specificity));
  return fit.filter((m) => specificity(m) === best);
}

/**
 * The check classes a finding without a class can come from:
 *   1. a message seen in ATC results whose text fits (with that message id, without a code, or under any code);
 *   2. the reference system's classes with that message code. One code is used by many classes (0001, 0005 …): when a rule's
 *      text (rule.sci.text) fits the message, only the classes of those rules; otherwise all of them.
 */
function resolveClasses(a) {
  const id = String(a.messageId || '').toUpperCase();
  const idx = catalogIndex();
  const byId = id ? mostSpecific(idx.seen.filter((m) => m.code && m.code.toUpperCase() === id), a) : [];
  const seen = byId.length ? byId : mostSpecific(idx.seen.filter((m) => !m.code), a);
  const pick = seen.length ? seen : mostSpecific(idx.seen.filter(distinctive), a);
  if (pick.length) return [...new Set(pick.map((m) => m.clsname))];
  if (!id || ROOT_MESSAGES.some((r) => r.match.test(a.message.trim()))) return [];
  const classes = [...new Set((idx.byCode.get(id) || []).filter((m) => !m.match).map((m) => m.clsname))];
  const byRule = new Set();
  for (const r of BUILTIN_RULES) {
    if (!hasSciClasses(r) || !r.sci.text || !r.sci.text.test(a.message)) continue;
    const fams = r.sci.classes.map(classFamily);
    classes.filter((c) => fams.indexOf(classFamily(c)) >= 0).forEach((c) => byRule.add(c));
  }
  return byRule.size ? [...byRule] : classes;
}

/** The check classes for a message: a message code of many classes is shown as their number */
function classesLabel(classes) {
  if (!classes.length) return 'check class not reported';
  return classes.length > 3 ? 'one of ' + classes.length + ' check classes' : classes.join(' / ');
}

/** The check classes of finding a: its own, or the ones resolved from the catalog */
function classesOf(a) {
  return a.checkClass ? [a.checkClass] : a.classes || [];
}

/**
 * ATC diagnostics → { line, checkClass, classes, messageId, message, severity }.
 * checkClass is '' when ADT did not send one ("undefined - 0501"); classes are then resolved from the catalog.
 * @param {Array<{source?: string, code?: any, message: string, range: {start: {line: number}}, severity?: number}>} diags
 */
function readAtcDiagnostics(diags) {
  const out = [];
  for (const d of diags || []) {
    if (!d || d.source !== 'ATC') continue;
    const code = String(d.code && typeof d.code === 'object' ? d.code.value : d.code || '');
    const m = code.match(/^\s*(\S+)\s*-\s*(\S*)\s*$/);
    const cls = m ? m[1] : code;
    const a = {
      line: d.range.start.line,
      checkClass: /^(?:undefined|null)?$/i.test(cls) ? '' : cls,
      messageId: m ? m[2] : '',
      message: String(d.message || ''),
      severity: d.severity,
    };
    if (!a.checkClass) a.classes = resolveClasses(a);
    out.push(a);
  }
  return out;
}

/** Whether rule stands for the message of ATC finding a (check class family and message text) */
function ruleCovers(rule, a) {
  if (!hasSciClasses(rule)) return false;
  const fams = classesOf(a).map(classFamily);
  if (!rule.sci.classes.some((c) => fams.indexOf(classFamily(c)) >= 0)) return false;
  return !rule.sci.text || rule.sci.text.test(a.message);
}

/** Whether ATC finding a is the finding f of rule */
function matches(a, f, rule) {
  return a.line >= f.startLine && a.line <= f.endLine && ruleCovers(rule, a);
}

/** The rule with an annotation that stands for the message of ATC finding a, or null */
function ruleForAtc(a) {
  return BUILTIN_RULES.find((r) => r.token && ruleCovers(r, a)) || null;
}

/** The enabled rule that rewrites the statement of ATC finding a (atcFix, for a message no annotation suppresses), or null */
function atcFixRule(a, options) {
  return BUILTIN_RULES.find((r) => r.atcFix && ruleCovers(r, a) && F.ruleEnabled(r, options)) || null;
}

const norm = (u) => String(u || '').replace(/\s+/g, ' ').trim();

/**
 * The statement ATC reports a line of: the one containing it, else the next one (ATC can report a comment or blank line
 * in front of a statement).
 */
function statementAtLine(statements, line) {
  return statements.find((st) => st.startLine <= line && line <= st.endLine) ||
    statements.find((st) => st.startLine > line) || null;
}

/**
 * Match one analysis to the ATC findings of the same text.
 * @returns {{confirmed: Set<string>, unconfirmed: Set<string>, atcLines: Map<string, number>,
 *            unmatched: Array<{atc: object, stmt: string, offset: number}>}}
 *   confirmed / unconfirmed: finding keys; atcLines: line offset of the ATC finding inside the statement of a confirmed finding;
 *   unmatched: ATC findings without a rule, with the text of their statement and the line offset inside it
 */
function matchAtc(result, atcFindings) {
  const confirmed = new Set();
  const unconfirmed = new Set();
  const atcLines = new Map();
  const used = new Set();
  for (const f of result.findings) {
    const rule = RULE_BY_ID.get(f.ruleId);
    if (!hasSciClasses(rule)) continue;
    const i = atcFindings.findIndex((a, k) => !used.has(k) && matches(a, f, rule));
    if (i >= 0) {
      used.add(i);
      confirmed.add(f.key);
      atcLines.set(f.key, atcFindings[i].line - f.startLine);
    } else unconfirmed.add(f.key);
  }
  const unmatched = [];
  atcFindings.forEach((a, k) => {
    if (used.has(k)) return;
    const s = statementAtLine(result.statements, a.line);
    unmatched.push({ atc: a, stmt: s ? norm(s.upper) : '', offset: s ? Math.max(0, a.line - s.startLine) : 0 });
  });
  // What ATC checked, to follow each finding to its statement after the text changes (trackChanges / applyAtc)
  const base = {
    lines: result.lines.length,
    stmts: result.statements.map((s) => ({ startLine: s.startLine, endLine: s.endLine, text: plain(s.upper) })),
    findings: result.findings.map((f) => ({ key: f.key, stmtIndex: f.stmtIndex, ruleId: f.ruleId })),
  };
  return { confirmed, unconfirmed, atcLines, unmatched, base };
}

/** Statement text without pragmas: a statement that only got an annotation is still the one ATC checked */
const plain = (u) => norm(String(u || '').replace(/##[\w*]+(?:\[[^\]]*\])*/g, ' '));

/**
 * Follow the lines of the text ATC checked through changes of the document (the fix, an undo, typing), so applyAtc can
 * find each finding's statement by its position; statements whose text changes (a rewrite) keep their ATC status that way.
 * changes: [{ start, end, text }] (0-based lines of the range replaced, the new text) in the order the editor reports them.
 */
function trackChanges(state, changes) {
  if (!state || !state.base) return;
  if (!state.lineMap) state.lineMap = Int32Array.from({ length: state.base.lines }, (_, i) => i);
  const map = state.lineMap;
  for (const c of changes) {
    const k = (String(c.text).match(/\n/g) || []).length;
    const delta = k - (c.end - c.start);
    if (!delta && c.start === c.end) continue;
    for (let i = 0; i < map.length; i++) {
      const v = map[i];
      if (v > c.end) map[i] = v + delta;
      // A line inside the replaced range: the same line of the new text while there is one
      else if (v > c.start) map[i] = c.start + Math.min(v - c.start, k);
    }
  }
}

/** "line:n" of each statement: its start line and its place among the statements starting on that line */
function positionKeys(stmts, lineOf) {
  const seen = new Map();
  return stmts.map((s) => {
    const line = lineOf(s.startLine);
    const n = seen.get(line) || 0;
    seen.set(line, n + 1);
    return line + ':' + n;
  });
}

/**
 * The statement ATC checked of each statement of the current text, by position (state.lineMap), or null when the text
 * was not followed. Returns an array: current statement index → base statement index or -1.
 */
function baseStatements(result, state) {
  if (!state.base || !state.lineMap) return null;
  const map = state.lineMap;
  const byPos = new Map();
  positionKeys(state.base.stmts, (l) => (l < map.length ? map[l] : -1)).forEach((p, i) => {
    byPos.set(p, byPos.has(p) ? -1 : i);
  });
  return positionKeys(result.statements, (l) => l).map((p) => (byPos.has(p) ? byPos.get(p) : -1));
}

/**
 * Catalog entry of an ATC finding:
 *   1. a message every check class inherits (program does not exist / is read-protected): cannot be suppressed;
 *   2. a message seen in ATC results, recognized by its text, of the finding's check class family;
 *   3. the reference system's annotation of that check class and message code. Without a check class (ADT for VS Code),
 *      the message code of the classes resolveClasses found, and only when all of them use the same annotation.
 */
function catalogEntry(a) {
  const msg = a.message.trim();
  const root = ROOT_MESSAGES.find((r) => r.match.test(msg));
  if (root) return root;
  const idx = catalogIndex();
  const fams = [...new Set(classesOf(a).map(classFamily))];
  const inFams = (m) => fams.indexOf(classFamily(m.clsname)) >= 0;
  const id = String(a.messageId || '').toUpperCase();

  const seen = idx.seen.filter(inFams);
  const seenById = id ? seen.filter((m) => m.code && m.code.toUpperCase() === id) : [];
  // Also under another code: the code a system reports can differ
  const bySeen = mostSpecific(seenById, a)[0] || mostSpecific(seen.filter((m) => !m.code), a)[0] || mostSpecific(seen.filter(distinctive), a)[0];
  if (bySeen) return bySeen;

  if (!id) return null;
  const cands = (idx.byCode.get(id) || []).filter((m) => !m.match && (fams.length ? inFams(m) : true));
  if (!cands.length) return null;
  const sig = (m) => [m.pcom, m.pcom_alt, m.pragma].join('|');
  return cands.every((m) => sig(m) === sig(cands[0])) ? cands[0] : null;
}

/**
 * The annotation that suppresses ATC finding a, decided like CL_CI_TEST_ROOT->GET_MESSAGE_PCOMS: the check's own message
 * (SCI message catalog) first, the pragma before the pseudo comment; then the rule that stands for the message; then a
 * ##PRAGMA or "#EC pseudo comment named in the message text. Messages that cannot be suppressed in the code (NOX, exception table) need an exemption.
 * @returns {{token?: string, rule?: object, source: string, exemption?: boolean}}
 */
function markerForAtc(a, options) {
  const opts = options || {};
  const rule = ruleForAtc(a);
  // "atc:<message id>" in abap-smartfix.tokenOverrides: the annotation of an ATC message the catalog does not know
  const byId = a.messageId && (opts.tokenOverrides || {})['atc:' + String(a.messageId).toUpperCase()];
  if (byId && validToken(byId)) return { token: String(byId).trim(), rule, source: 'setting' };
  const override = rule && (opts.tokenOverrides || {})[rule.id];
  if (override && validToken(override)) return { token: String(override).trim(), rule, source: 'setting' };
  const m = catalogEntry(a);
  if (m) {
    const pcom = String(m.pcom || '').trim();
    const pragma = String(m.pragma || '').trim();
    if (!pragma && (!pcom || pcom === 'NOX' || pcom === 'CI_TABL_EXCEPTN')) {
      if (pcom === 'NOX' || pcom === 'CI_TABL_EXCEPTN') return { rule, source: 'catalog', exemption: true };
    } else {
      const usePragma = pragma && !(opts.suppressStyle === 'pseudo' && pcom);
      return { token: usePragma ? '##' + pragma.replace(/^##/, '') : '"#EC ' + pcom, rule, source: 'catalog' };
    }
  }
  if (rule) return { token: rule.token, rule, source: 'rule' };
  const named = a.message.match(/##[A-Za-z0-9_]+/);
  if (named) return { token: named[0].toUpperCase(), source: 'message' };
  const pseudo = a.message.match(/"#EC\s+([A-Za-z0-9_]+)/i);
  if (pseudo) return { token: '"#EC ' + pseudo[1].toUpperCase(), source: 'message' };
  return { source: 'none' };
}

/** Location and common fields of a finding on statement s for ATC finding a, shown on the line ATC reports (line) */
function baseFinding(result, s, a, line) {
  return Object.assign(F.locationOf(s, result.lines), {
    rewrite: null,
    fixMode: 'auto',
    custom: false,
    atc: a,
    line,
    key: 'atc\u0001' + (a.checkClass || classesOf(a)[0] || '') + ' ' + a.messageId + '\u0001' + norm(s.upper),
  });
}

/**
 * The statement of an unmatched ATC finding in the current text. Same version: the reported line. Otherwise the statement
 * with the same text; of several identical statements (the same CALL FUNCTION repeated), the one nearest the reported line.
 */
function statementOf(result, u, sameVersion, pos) {
  if (sameVersion) return statementAtLine(result.statements, u.atc.line);
  if (pos) {
    // Followed by position: the statement ATC reported, as long as only annotations were added to it (a rewritten
    // statement is no longer the one ATC checked; the next ATC run tells whether anything is left)
    const b = statementAtLine(pos.base.stmts, u.atc.line);
    const i = b ? pos.map.indexOf(pos.base.stmts.indexOf(b)) : -1;
    return i >= 0 && plain(result.statements[i].upper) === b.text ? result.statements[i] : null;
  }
  if (!u.stmt) return null;
  let best = null;
  for (const st of result.statements) {
    if (norm(st.upper) !== u.stmt) continue;
    if (!best || Math.abs(st.startLine + u.offset - u.atc.line) < Math.abs(best.startLine + u.offset - u.atc.line)) best = st;
  }
  return best;
}

/**
 * A finding for an ATC finding the analysis did not produce, placed on its statement (or its line), with the annotation
 * markerForAtc finds (ATC has confirmed the finding), or the rewrite of the rule's atcFix for a message no annotation
 * suppresses; without either, a manual finding (with the reason, e.g. an exemption).
 */
function manualFinding(result, u, sameVersion, options, pos) {
  const s = statementOf(result, u, sameVersion, pos);
  if (!s) return null;
  const a = u.atc;
  const line = sameVersion
    ? Math.min(Math.max(a.line, s.startLine), s.endLine)
    : Math.min(s.startLine + (u.offset || 0), s.endLine);
  const severity = a.severity === 0 ? 'error' : a.severity === 1 ? 'warning' : 'information';
  const classes = classesOf(a);
  const what = classesLabel(classes) + (a.messageId ? ' ' + a.messageId : '');

  const rule = atcFixRule(a, options);
  if (rule) {
    const ctx = { statements: result.statements, lines: result.lines, comments: result.comments, localNames: result.localNames, ddic: (options && options.ddic) || null, options: options || {} };
    let rewrite = null;
    try {
      rewrite = rule.atcFix(s, ctx, a) || null;
    } catch (e) {
      rewrite = null;
    }
    const mode = F.fixModeOf(rule.id, options);
    const action = F.decideAction(mode, rewrite, false);
    // Without a rewrite, the rule's detail says why the statement is left for a manual fix
    let blocked = '';
    if (!rewrite && typeof rule.detail === 'function') {
      try { blocked = rule.detail(s, ctx) || ''; } catch (e) { blocked = ''; }
    }
    return Object.assign(baseFinding(result, s, a, line), {
      ruleId: rule.id,
      kind: 'rewrite',
      token: '',
      tokenName: '',
      canSuppress: false,
      rewrite,
      action,
      fixMode: mode,
      fixLabel: F.fixLabel(action, '', rewrite),
      title: rule.title,
      detail: 'reported by ATC (' + what + ')' + (blocked ? '; ' + blocked : ''),
      why: rule.why,
      exemption: !rewrite,
      tokenSource: 'atc',
      sciClasses: classes,
      severity,
    });
  }

  const mk = markerForAtc(a, options);
  // Only a plain annotation reaches the code, whatever the catalog or the ATC message text holds
  if (mk.token && validToken(mk.token)) {
    const kind = kindOfToken(mk.token);
    const name = tokenName(kind, mk.token);
    // Already annotated (e.g. after the fix): nothing left to do
    if (F.isAnnotated(F.presentAnnotations(s), [name])) return null;
    return Object.assign(baseFinding(result, s, a, line), {
      ruleId: mk.rule ? mk.rule.id : 'atc',
      kind,
      token: mk.token,
      tokenName: name,
      canSuppress: true,
      action: 'suppress',
      fixLabel: mk.token,
      title: mk.rule ? mk.rule.title : 'ATC: ' + a.message,
      detail: 'reported by ATC' + (mk.source === 'catalog' ? ', annotation of ' + what : ''),
      why: mk.rule ? mk.rule.why : 'Reported by ATC in the SAP system (' + what + '). The annotation is the one this check message uses (SCI message catalog).',
      tokenSource: 'atc-' + mk.source,
      sciClasses: mk.rule ? mk.rule.sci.classes : classes,
      severity: (mk.rule && mk.rule.severity) || severity,
    });
  }
  return Object.assign(baseFinding(result, s, a, line), {
    ruleId: 'atc',
    kind: 'rewrite',
    token: '',
    tokenName: '',
    canSuppress: false,
    action: 'manual',
    fixLabel: 'Manual fix',
    title: 'ATC: ' + a.message,
    detail: what,
    why: mk.exemption
      ? 'Reported by ATC in the SAP system (' + what + '). This message cannot be suppressed with a pragma or pseudo comment: fix the code or request an ATC exemption.'
      : 'Reported by ATC in the SAP system (' + what + '). No annotation is known for this message: fix the code, or see the ATC result in ADT for the pseudo comment or an exemption.',
    exemption: !!mk.exemption,
    tokenSource: 'atc',
    sciClasses: classes,
    severity,
  });
}

/**
 * Apply a stored ATC state to an analysis: hide unconfirmed findings, add the unmatched ATC findings as manual ones.
 * sameVersion: the text is the one ATC checked, so line numbers can be used; otherwise statements are found by their text.
 * Every finding ATC reported is shown on the line ATC reports (line), which may be inside a multi-line statement.
 * @returns {object} result with filtered findings (same object, findings replaced)
 */
function applyAtc(result, state, sameVersion, options) {
  if (!state) return result;
  const map = sameVersion ? null : baseStatements(result, state);
  const pos = map ? { base: state.base, map } : null;
  if (pos) followFindings(result, state, pos);
  const kept = result.findings.filter((f) => !state.unconfirmed.has(f.key) && !f.atcNew);
  for (const f of kept) {
    const off = state.atcLines && state.atcLines.get(f.key);
    if (off != null) f.line = Math.min(Math.max(f.startLine + off, f.startLine), f.endLine);
  }
  const extra = [];
  for (const u of state.unmatched) {
    const f = manualFinding(result, u, sameVersion, options, pos);
    if (f && !extra.some((e) => e.key === f.key && e.startLine === f.startLine)) extra.push(f);
  }
  // Identical statements (the same CALL FUNCTION repeated) give the same key: number them, so each has its own checkbox and fix
  // With the checked text known, by the statement ATC reported (stays the same when an identical statement before it is fixed)
  const seen = new Map();
  for (const f of extra.sort((a, b) => a.startLine - b.startLine)) {
    const n = seen.get(f.key) || 0;
    seen.set(f.key, n + 1);
    f.key += '\u0001' + (state.base ? (pos ? pos.map[f.stmtIndex] : f.stmtIndex) : n);
  }
  result.atcHidden = result.findings.length - kept.length;
  // The findings of the source rules before ATC filtered them: the self-check (verify.js) compares a re-analysis with these
  result.sourceFindings = result.findings;
  result.findings = kept.concat(extra).sort((a, b) => a.startLine - b.startLine || a.ruleId.localeCompare(b.ruleId));
  return result;
}

/**
 * After the text changed (a fix, typing): each finding of a rule takes the key of the same rule's finding on the statement
 * ATC checked at its position, so what ATC confirmed or hid (and the sidebar checkbox) stays with it, also when a pragma or
 * a rewrite changed the statement's text. A finding of a rule with SCI classes that was not there when ATC ran (a rewrite made
 * it appear, or new code) is not shown (atcNew): ATC has not reported it; the next ATC run checks it.
 */
function followFindings(result, state, pos) {
  const byStmt = new Map();
  for (const b of state.base.findings) {
    if (!byStmt.has(b.stmtIndex)) byStmt.set(b.stmtIndex, []);
    byStmt.get(b.stmtIndex).push(b);
  }
  const used = new Set();
  const own = [];
  for (const f of result.findings) {
    const bi = pos.map[f.stmtIndex];
    const b = bi >= 0 && (byStmt.get(bi) || []).find((x) => x.ruleId === f.ruleId && !used.has(x.key));
    if (b) {
      used.add(b.key);
      f.key = b.key;
      continue;
    }
    own.push(f);
    // Kept when the key is one ATC decided on (the same statement text elsewhere)
    if (state.confirmed.has(f.key) || state.unconfirmed.has(f.key)) continue;
    if (hasSciClasses(RULE_BY_ID.get(f.ruleId))) f.atcNew = true;
  }
  // Two findings must not share a key: one that kept its own text key yields to one that took it by position
  for (const f of own) if (used.has(f.key)) f.key += '\u0001moved';
}

/**
 * What an ATC run tells about the system that the source and the ADT table definition do not show: which tables are
 * buffered (technical settings). Remembered per destination, so the source rules can use it without ATC.
 * @returns {{buffered: Object<string, string>}} table name (upper case) → 'buffered' | 'generic' | 'single'
 */
function factsFrom(atcFindings) {
  const buffered = {};
  const kinds = [
    [/Buffered table ([A-Z0-9_\/]+) in a JOIN/i, 'buffered'],
    [/Generically buffered key range not fully specified for table ([A-Z0-9_\/]+)/i, 'generic'],
    [/single record buffered table ([A-Z0-9_\/]+)/i, 'single'],
  ];
  for (const a of atcFindings || []) {
    for (const [re, kind] of kinds) {
      const m = a.message.match(re);
      // The buffering type is more specific than "buffered"
      if (m && (!buffered[m[1].toUpperCase()] || kind !== 'buffered')) buffered[m[1].toUpperCase()] = kind;
    }
  }
  return { buffered };
}

module.exports = { readAtcDiagnostics, matchAtc, applyAtc, trackChanges, classFamily, markerForAtc, classesLabel, factsFrom };
