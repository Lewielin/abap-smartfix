'use strict';

/**
 * Self-check of code rewrites before they reach the customer's code.
 *
 * Each rewrite is applied in memory and the result is analyzed again. A rewrite is rejected when
 *   - it changes the block structure (IF / ENDIF, LOOP / ENDLOOP, SELECT … ENDSELECT, METHOD / ENDMETHOD … no longer balance
 *     the way they did), or
 *   - its finding is still there afterwards (the rewrite did not fix what it claims to fix); a finding only ATC reported is
 *     checked by the next ATC run.
 * All rewrites are first checked together (one extra analysis); only when that fails is each one checked alone to find the culprit.
 */

const { planEdits, applyEditsToText } = require('./fixer');
const { fixLabel } = require('./finding');

const PAIRS = [
  ['IF', /^IF(?=\s|$)/, /^ENDIF(?=\s|\.|$)/],
  ['CASE', /^CASE(?=\s|$)/, /^ENDCASE(?=\s|$)/],
  ['LOOP', /^LOOP(?=\s|$)/, /^ENDLOOP(?=\s|$)/],
  ['DO', /^DO(?=\s|$)/, /^ENDDO(?=\s|$)/],
  ['WHILE', /^WHILE(?=\s|$)/, /^ENDWHILE(?=\s|$)/],
  ['TRY', /^TRY(?=\s|$)/, /^ENDTRY(?=\s|$)/],
  ['AT', /^AT\s+(?:NEW|END\s+OF|FIRST|LAST)\b/, /^ENDAT(?=\s|$)/],
  ['FORM', /^FORM\s/, /^ENDFORM(?=\s|$)/],
  ['METHOD', /^METHOD\s/, /^ENDMETHOD(?=\s|$)/],
  ['FUNCTION', /^FUNCTION\s/, /^ENDFUNCTION(?=\s|$)/],
  ['MODULE', /^MODULE\s+\S+\s+(?:INPUT|OUTPUT)\b/, /^ENDMODULE(?=\s|$)/],
  ['CLASS', /^CLASS\s+\S+\s+(?:DEFINITION|IMPLEMENTATION)\b(?![\s\S]*\b(?:DEFERRED|LOAD)\b)/, /^ENDCLASS(?=\s|$)/],
];

/** openers − closers per block kind, and ENDSELECTs without a SELECT loop */
function structureOf(result) {
  const sig = {};
  for (const [name] of PAIRS) sig[name] = 0;
  let endselect = 0;
  for (const s of result.statements) {
    const u = s.upper;
    for (const [name, open, close] of PAIRS) {
      if (open.test(u)) sig[name]++;
      else if (close.test(u)) sig[name]--;
    }
    if (/^ENDSELECT(?=\s|$)/.test(u)) endselect++;
  }
  sig.ENDSELECT = endselect - (result.selectLoops ? result.selectLoops.size : 0);
  return sig;
}

function sameStructure(a, b) {
  return Object.keys(a).every((k) => a[k] === b[k]);
}

function countByRule(findings) {
  const n = new Map();
  for (const f of findings) n.set(f.ruleId, (n.get(f.ruleId) || 0) + 1);
  return n;
}

/**
 * @param {string} text        source the findings were computed on
 * @param {object} result      analyze(text, options)
 * @param {Array}  picked      findings about to be fixed
 * @param {function} reanalyze (text) => analyze(text, options)
 * @returns {Map<string, string>} finding key → why its rewrite was rejected (empty when every rewrite passes)
 */
function verifyRewrites(text, result, picked, reanalyze) {
  const rewrites = picked.filter((f) => f.action === 'rewrite');
  const rejected = new Map();
  if (!rewrites.length) return rejected;
  const base = structureOf(result);
  // With an ATC result the shown findings are filtered; the re-analysis is not, so compare with the unfiltered ones
  const before = countByRule(result.sourceFindings || result.findings);

  const check = (list) => {
    const plan = planEdits(result.lines, result.comments, list);
    let after;
    try {
      after = reanalyze(applyEditsToText(text, plan.edits));
    } catch (e) {
      return 'the result could not be analyzed';
    }
    if (!sameStructure(base, structureOf(after))) return 'the block structure would change';
    // A finding only ATC reported (f.atc) is not in the re-analysis either way: the next ATC run tells whether it is gone
    const fixed = countByRule(list.filter((f) => !f.atc));
    const now = countByRule(after.findings);
    for (const [ruleId, n] of fixed) {
      if ((now.get(ruleId) || 0) > (before.get(ruleId) || 0) - n) return 'the finding would still be reported';
    }
    return '';
  };

  // Find the culprits by halving: a large program takes seconds per analysis, so checking every rewrite alone
  // (one analysis each) would block the editor for minutes
  const search = (list, why) => {
    if (!why) return;
    if (list.length === 1) {
      rejected.set(list[0].key, why);
      return;
    }
    const half = Math.ceil(list.length / 2);
    const a = list.slice(0, half);
    const b = list.slice(half);
    search(a, check(a));
    search(b, check(b));
  };
  search(rewrites, check(rewrites));
  return rejected;
}

/**
 * Replace the action of findings whose rewrite was rejected: annotate when possible, otherwise leave for manual fixing.
 * Mutates the findings (they come from a fresh analysis for this fix).
 */
function downgradeRejected(picked, rejected) {
  for (const f of picked) {
    const why = rejected.get(f.key);
    if (!why) continue;
    f.verifyFailed = why;
    f.action = f.canSuppress ? 'suppress' : 'manual';
    f.fixLabel = fixLabel(f.action, f.token, null);
  }
}

module.exports = { verifyRewrites, downgradeRejected };
