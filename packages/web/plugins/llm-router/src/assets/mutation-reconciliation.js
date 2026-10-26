// @ts-check
/** @typedef {'unknown'|'accepted'} MutationOutcome */
/** @typedef {{ readonly outcome: MutationOutcome, readonly readFloor: number }} MutationLock */

export function createMutationReconciliation() {
  let readRevision = 0;
  /** @type {Map<string,MutationLock>} */
  const locks = new Map();
  return {
    beginRead() { return ++readRevision; },
    /** @param {string} key */
    unknown(key) { locks.set(key, { outcome: 'unknown', readFloor: readRevision }); },
    /** @param {string} key */
    accepted(key) { locks.set(key, { outcome: 'accepted', readFloor: readRevision }); },
    /** @param {string} key */
    outcome(key) { return locks.get(key)?.outcome; },
    /** @param {string} key */
    locked(key) { return locks.has(key); },
    anyUnknown() { return [...locks.values()].some(({ outcome }) => outcome === 'unknown'); },
    /** @param {string} key */
    edit(key) { if (locks.get(key)?.outcome === 'accepted') locks.delete(key); },
    /** @param {number} read @param {string} key @param {boolean|undefined} committed */
    reconcile(read, key, committed) {
      const lock = locks.get(key);
      if (!lock || read <= lock.readFloor || lock.outcome === 'accepted') return lock?.outcome;
      if (committed === undefined) return lock.outcome;
      if (committed) locks.set(key, { outcome: 'accepted', readFloor: lock.readFloor });
      else locks.delete(key);
      return locks.get(key)?.outcome;
    },
    clear() { locks.clear(); }
  };
}
