'use strict';

/**
 * Which findings are checked in the sidebar (and so included in the auto fix).
 *
 * Only the unchecked ones are stored, so new findings start checked. Findings are identified by finding.key
 * (rule + statement text + occurrence), which stays the same when lines above are inserted or deleted.
 */
class Selection {
  constructor() {
    /** @type {Map<string, Set<string>>} file uri → keys of unchecked findings */
    this.unchecked = new Map();
  }

  isChecked(uri, key) {
    const set = this.unchecked.get(uri);
    return !set || !set.has(key);
  }

  set(uri, key, checked) {
    let set = this.unchecked.get(uri);
    if (checked) {
      if (set) set.delete(key);
      if (set && !set.size) this.unchecked.delete(uri);
      return;
    }
    if (!set) this.unchecked.set(uri, (set = new Set()));
    set.add(key);
  }

  /** Check or uncheck every finding of a file */
  setAll(uri, findings, checked) {
    if (checked) {
      this.unchecked.delete(uri);
      return;
    }
    this.unchecked.set(uri, new Set(findings.map((f) => f.key)));
  }

  /** Forget unchecked keys that no longer exist (the finding was fixed or the code changed) */
  prune(uri, findings) {
    const set = this.unchecked.get(uri);
    if (!set) return;
    const live = new Set(findings.map((f) => f.key));
    for (const k of [...set]) if (!live.has(k)) set.delete(k);
    if (!set.size) this.unchecked.delete(uri);
  }

  forget(uri) {
    this.unchecked.delete(uri);
  }

  clear() {
    this.unchecked.clear();
  }

  /** Findings of the file that are checked */
  checkedOf(uri, findings) {
    return findings.filter((f) => this.isChecked(uri, f.key));
  }
}

module.exports = { Selection };
