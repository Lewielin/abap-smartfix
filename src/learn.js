'use strict';

/**
 * Learn the annotation names a code base already uses.
 *
 * Every statement that a rule reports is looked at with its existing pseudo comments / pragmas. When exactly one rule on
 * the statement is missing its annotation and exactly one annotation on it is not explained by the other rules, that
 * annotation is a vote for the rule. Enough agreeing votes make a suggestion for abap-smartfix.tokenOverrides.
 */

const { analyze } = require('./analyzer');
const { validToken } = require('./rules');
const { RULE_BY_ID } = require('./finding');

const MIN_VOTES = 3;
const MIN_SHARE = 0.6;

/** "#EC form for a pseudo comment name, ## form stays */
function asToken(name) {
  return /^##/.test(name) ? name : '"#EC ' + name;
}

/**
 * @param {Array<{path: string, text: string}>} files
 * @param {object} options analyzer options (tokenOverrides, suppressStyle …)
 * @returns {{suggestions: Array, statements: number}}
 *   suggestions: { ruleId, token, votes, of, example }  another name than the rule's is used consistently
 */
function learnAnnotations(files, options) {
  const rules = RULE_BY_ID;
  const votes = new Map(); // ruleId → Map(name → { n, example })
  let statements = 0;

  for (const file of files) {
    let result;
    try {
      result = analyze(file.text, Object.assign({}, options, { ignoreAnnotations: true, enabledRules: [...rules.keys()] }));
    } catch (e) {
      continue;
    }
    const byStmt = new Map();
    for (const f of result.findings) {
      if (!byStmt.has(f.stmtIndex)) byStmt.set(f.stmtIndex, []);
      byStmt.get(f.stmtIndex).push(f);
    }
    for (const [, group] of byStmt) {
      const present = new Set(group[0].present.filter((n) => n !== '*'));
      if (!present.size) continue;
      statements++;
      const example = file.path + ':' + (group[0].startLine + 1);
      const explained = new Set();
      for (const f of group) f.variants.filter((v) => present.has(v)).forEach((v) => explained.add(v));
      const missing = group.filter((f) => !f.annotated && f.token);
      const rest = [...present].filter((n) => !explained.has(n));
      if (missing.length !== 1 || rest.length !== 1) continue;
      const f = missing[0];
      const rule = rules.get(f.ruleId);
      const name = rest[0];
      if (rule && (rule.notTokens || []).indexOf(name.replace(/^##/, '')) >= 0) continue;
      if (!votes.has(f.ruleId)) votes.set(f.ruleId, new Map());
      const v = votes.get(f.ruleId).get(name) || { n: 0, example };
      v.n++;
      votes.get(f.ruleId).set(name, v);
    }
  }

  const suggestions = [];
  for (const [ruleId, names] of votes) {
    const total = [...names.values()].reduce((s, v) => s + v.n, 0);
    const [best, v] = [...names.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (v.n >= MIN_VOTES && v.n / total >= MIN_SHARE && validToken(asToken(best))) {
      suggestions.push({ ruleId, token: asToken(best), votes: v.n, of: total, example: v.example });
    }
  }
  suggestions.sort((a, b) => b.votes - a.votes);
  return { suggestions, statements };
}

module.exports = { learnAnnotations };
