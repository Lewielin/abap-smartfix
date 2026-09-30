'use strict';

/**
 * Program structure that several checks share: loops with their ranges.
 */

const SX = require('./syntax');

const LOOP_OPEN = /^(LOOP|DO|WHILE|PROVIDE)(?=\s|$)/;
const LOOP_CLOSE = /^(ENDLOOP|ENDDO|ENDWHILE|ENDPROVIDE)(?=\s|$)/;

/**
 * Loops, including SELECT … ENDSELECT.
 * @returns {{enclosing: number[][], end: Map<number, number>}}
 *   enclosing[i]: start indexes of the loops around statement i (outermost first; a loop statement is not inside itself)
 *   end: loop start index → index of its closing statement
 */
function buildLoops(statements, selectLoops) {
  const enclosing = new Array(statements.length);
  const end = new Map();
  const selectEnds = new Set(selectLoops.values());
  let stack = [];
  for (let i = 0; i < statements.length; i++) {
    const u = statements[i].upper;
    if (SX.isUnitBoundary(u)) stack = [];
    if (LOOP_CLOSE.test(u) || selectEnds.has(i)) {
      const open = stack.pop();
      if (open != null) end.set(open, i);
    }
    enclosing[i] = stack.slice();
    if (LOOP_OPEN.test(u) || selectLoops.has(i)) stack.push(i);
  }
  return { enclosing, end };
}

module.exports = { buildLoops };
