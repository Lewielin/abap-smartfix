'use strict';

/**
 * What every finding shares, whether a source rule (analyzer.js) or ATC (atc.js) produced it: the rule registry, whether a
 * rule is on, how the finding is fixed (fix mode → action and label), where it is, and whether its statement is annotated.
 */

const { RULES } = require('./rules');
const { SCI_RULES } = require('./rules-sci');

/** The built-in rules (custom rules are compiled per analysis) */
const BUILTIN_RULES = RULES.concat(SCI_RULES);
const RULE_BY_ID = new Map(BUILTIN_RULES.map((r) => [r.id, r]));

const FIX_MODES = ['auto', 'rewrite', 'suppress'];

/** abap-smartfix.enabledRules / disabledRules, otherwise the rule's own default */
function ruleEnabled(rule, options) {
  const opts = options || {};
  if (opts.enabledRules && opts.enabledRules.indexOf(rule.id) >= 0) return true;
  if (opts.disabledRules && opts.disabledRules.indexOf(rule.id) >= 0) return false;
  return rule.enabled !== false;
}

/** Whether a rule follows SCI check classes, so ATC can confirm or hide its findings */
function hasSciClasses(rule) {
  return !!(rule && rule.sci && rule.sci.classes && rule.sci.classes.length);
}

/** Fix mode of a rule: abap-smartfix.ruleFixModes, otherwise fixMode, otherwise auto */
function fixModeOf(ruleId, options) {
  const opts = options || {};
  const own = (opts.ruleFixModes || {})[ruleId];
  if (FIX_MODES.indexOf(own) >= 0) return own;
  return FIX_MODES.indexOf(opts.fixMode) >= 0 ? opts.fixMode : 'auto';
}

/**
 * Decide how to fix a finding:
 *   suppress only add annotations (rules without an annotation → manual)
 *   auto     rewrite when a safe rewrite exists, otherwise annotate
 *   rewrite  rewrite when any rewrite exists (including review), otherwise annotate
 */
function decideAction(mode, rewrite, canSuppress) {
  if (mode === 'suppress') return canSuppress ? 'suppress' : 'manual';
  if (rewrite && (mode === 'rewrite' || rewrite.safety === 'safe')) return 'rewrite';
  if (canSuppress) return 'suppress';
  return 'manual';
}

/** The fix as the sidebar and the Quick Pick show it */
function fixLabel(action, token, rewrite) {
  if (action === 'rewrite') return 'Rewrite: ' + rewrite.summary;
  if (action === 'suppress') return token;
  return 'Manual fix';
}

/**
 * Pseudo comments and pragmas (without parameters) on a statement.
 * Only the first #EC on a line is effective; a later #EC on the same line is plain text (as in SAP and abap-cleaner)
 */
function presentAnnotations(s) {
  return new Set(s.pragmas.map((p) => p.replace(/\[[^\]]*\]$/, '')).concat(s.pseudoComments));
}

/** Whether one of the annotation names is present ("#EC * skips every Code Inspector (CI_…) check) */
function isAnnotated(present, names) {
  return names.some((n) => present.has(n)) || (present.has('*') && names.some((n) => /^CI_/.test(n)));
}

function snippetOf(lines, startLine, endLine) {
  const last = Math.min(endLine, startLine + 2);
  const part = lines.slice(startLine, last + 1).map((l) => l.trim()).filter(Boolean);
  let text = part.join(' ');
  if (endLine > last) text += ' ...';
  return text.length > 200 ? text.slice(0, 197) + '...' : text;
}

/** Position fields of a finding on statement s */
function locationOf(s, lines) {
  return {
    stmtIndex: s.index,
    startLine: s.startLine,
    startCol: s.startCol,
    endLine: s.endLine,
    endCol: s.endCol,
    // Only one pseudo comment per line; when a statement needs several, the fixer breaks the line between words
    words: s.words.map((w) => ({ line: w.line, col: w.col, upper: w.upper })),
    terminator: s.terminator,
    chained: s.chained,
    // EXEC SQL … ENDEXEC: a pseudo comment only counts after the period of ENDEXEC
    lastLineOnly: !!s.lastLineOnly,
    code: s.text.length > 300 ? s.text.slice(0, 297) + '...' : s.text,
    snippet: snippetOf(lines, s.startLine, s.endLine),
  };
}

module.exports = {
  BUILTIN_RULES,
  RULE_BY_ID,
  ruleEnabled,
  hasSciClasses,
  fixModeOf,
  decideAction,
  fixLabel,
  presentAnnotations,
  isAnnotated,
  locationOf,
};
