// @ts-check
const STORAGE_KEY = "dim.browser-session.epoch";
/** @type {string | null} */
let activeEpoch = null;
/** @type {string | null} */
let documentEpoch = null;
let storageAvailable = true;

function storedEpoch() { try { const value = localStorage.getItem(STORAGE_KEY); storageAvailable = true; return value; } catch { storageAvailable = false; return null; } }
/** @param {string} value */
function writeEpoch(value) { try { localStorage.setItem(STORAGE_KEY, value); storageAvailable = true; return true; } catch { storageAvailable = false; return false; } }

export function sessionStorageAvailable() { return storageAvailable; }
export function captureSessionEpoch() { return activeEpoch ?? storedEpoch(); }
/** @param {string | null} epoch */
export function sessionEpochUnchanged(epoch) { const stored = storedEpoch(); return storageAvailable && stored === epoch; }
/** @param {string | null} [epoch] */
export function isSessionEpochCurrent(epoch = activeEpoch) { const stored = storedEpoch(); return storageAvailable && epoch !== null && activeEpoch === epoch && stored === epoch; }
/** @param {boolean} rotate */
export function beginBrowserSession(rotate) {
  const existing = storedEpoch(), selected = rotate || existing === null ? crypto.randomUUID() : existing;
  if ((selected !== existing && !writeEpoch(selected)) || !storageAvailable) { activeEpoch = null; return null; }
  activeEpoch = selected; documentEpoch = selected; return selected;
}
export function invalidateBrowserSession(notify = true) { activeEpoch = null; if (notify) { try { localStorage.removeItem(STORAGE_KEY); } catch { storageAvailable = false; } } documentEpoch = storedEpoch(); }
/** @param {()=>void} onInvalidated */
export function observeBrowserSession(onInvalidated) {
  documentEpoch = storedEpoch();
  const verify = () => { const stored = storedEpoch(); if (!storageAvailable || stored !== documentEpoch) { documentEpoch = stored; onInvalidated(); } };
  const storage = (/** @type {StorageEvent} */ event) => { if (event.key === STORAGE_KEY || event.key === null) verify(); };
  window.addEventListener("storage", storage); window.addEventListener("focus", verify); document.addEventListener("visibilitychange", verify);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener("focus", verify); document.removeEventListener("visibilitychange", verify); };
}
