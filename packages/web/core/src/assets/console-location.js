// @ts-check

/** @param {string} hash @returns {string[] | null} */
export function parseLocation(hash) {
  if (!hash || hash === "#" || hash === "#/") return [];
  if (!hash.startsWith("#/") || hash.length > 4096) return null;
  try {
    const path = hash.slice(2).split("/").map(decodeURIComponent);
    return path.length <= 16 && path.every((part) => part.length > 0 && part.length <= 256 && !/[\u0000-\u001f\u007f/#?]/u.test(part)) ? path : null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}
/** @returns {string[]} */
export function readLocation() { return parseLocation(window.location.hash) ?? ["invalid"]; }
/** @param {readonly string[]} path */
export function hrefLocation(path) { return `#/${path.map(encodeURIComponent).join("/")}`; }
/** @param {readonly string[]} path @param {boolean} [replace] */
export function navigateLocation(path, replace = false) {
  const hash = hrefLocation(path);
  if (window.location.hash === hash) return;
  if (replace) {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else window.location.hash = hash;
}
/** @param {(path:string[])=>void} handler */
export function subscribeLocation(handler) {
  const listener = () => handler(readLocation());
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
/** @param {readonly string[]} scope @param {()=>boolean} current @returns {import('../plugin-api.js').WebPluginLocation} */
export function scopedLocation(scope, current) {
  const matches = (/** @type {readonly string[]} */ path) => scope.every((part, index) => path[index] === part);
  return {
    get path() { const path = readLocation(); return matches(path) ? path.slice(scope.length) : []; },
    href(path) { return hrefLocation([...scope, ...path]); },
    navigate(path, options) { if (current()) navigateLocation([...scope, ...path], options?.replace); },
    subscribe(handler) { return subscribeLocation((path) => { if (current() && matches(path)) handler(path.slice(scope.length)); }); }
  };
}
