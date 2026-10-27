// @ts-check
/** @typedef {Pick<import('@slop-lab/dim-contracts-ci/query').ExecutionSummary,'phase'|'cancelRequestedAt'>} Summary */
export function createCancellationState() {
  let reads = 0;
  /** @type {Map<string,{outcome:'unknown'|'accepted'|'observed',floor:number}>} */ const locks = new Map();
  return {
    beginRead() { return ++reads; },
    unknown(/** @type {string} */ key) { locks.set(key,{outcome:'unknown',floor:reads}); },
    accepted(/** @type {string} */ key) { locks.set(key,{outcome:'accepted',floor:reads}); },
    locked(/** @type {string} */ key) { return locks.has(key); },
    outcome(/** @type {string} */ key) { return locks.get(key)?.outcome; },
    fresh(/** @type {string} */ key, /** @type {number} */ read) { return read > (locks.get(key)?.floor ?? -1); },
    /** @param {string} key @param {number} read @param {Summary} job */
    reconcile(key,read,job) {
      const lock = locks.get(key);
      if (!lock || lock.outcome !== 'unknown' || read <= lock.floor) return;
      if (job.cancelRequestedAt !== undefined || job.phase === 'finished') locks.set(key,{outcome:'observed',floor:lock.floor});
      else locks.delete(key);
    },
    clear() { locks.clear(); }
  };
}
