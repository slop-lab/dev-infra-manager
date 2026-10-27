// @ts-check

/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{section:'accounts'|'projects'|'traffic', objectId:string, valid:boolean}} RouterRoute */

const sections = new Set(["accounts", "projects", "traffic"]);

/** @param {readonly string[]} path @returns {RouterRoute} */
export function parseRouterRoute(path) {
  const [section, objectId = "", ...extra] = path;
  if (!section || !sections.has(section) || extra.length > 0 || section === "traffic" && objectId !== "") {
    return { section: "accounts", objectId: "", valid: false };
  }
  return { section: /** @type {'accounts'|'projects'|'traffic'} */ (section), objectId, valid: true };
}

/** @param {Context} context @param {readonly string[]} path */
export function routerHref(context, path) {
  return context.location?.href(path) ?? "#";
}

/** @param {Context} context @param {string} label @param {readonly string[]} path @param {string} [className] @param {()=>void|Promise<void>} [open] */
export function routerLink(context, label, path, className = "", open) {
  const link = document.createElement("a");
  link.href = routerHref(context, path);
  link.textContent = label;
  link.className = className;
  if (!context.location) link.addEventListener("click", (event) => { event.preventDefault(); void open?.(); });
  return link;
}

/** @param {Context} context @param {(route:RouterRoute)=>void|Promise<void>} apply */
export function mountRouterLocation(context, apply) {
  if (!context.location) {
    void apply({ section: "accounts", objectId: "", valid: true });
    return () => {};
  }
  const update = (/** @type {readonly string[]} */ path) => {
    const route = parseRouterRoute(path);
    void apply(route);
  };
  update(context.location.path);
  return context.location.subscribe(update);
}
