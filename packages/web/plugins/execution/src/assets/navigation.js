// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebNavigationResult} NavigationResult */
/** @typedef {{kind:'repository-jobs',controllerKey:string,projectId:string,repositoryId:string}|{kind:'job',controllerKey:string,jobId:string}} Target */
/** @returns {NavigationResult} */
const invalid = () => ({ status: "unavailable", code: "invalid-target", message: "The navigation target is invalid." });
/** @returns {NavigationResult} */
const unavailable = () => ({ status: "unavailable", code: "target-unavailable", message: "The requested execution target is unavailable." });
/** @param {unknown} value @returns {value is string} */
const controllerKey = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
/** @param {unknown} value @returns {value is string} */
const identifier = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
/** @param {unknown} value @returns {value is string} */
const jobId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
/** @param {unknown} value @param {readonly string[]} keys */
function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
}
/** @param {unknown} value @returns {Target|undefined} */
function parseTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) return undefined;
  const target = /** @type {Record<string,unknown>} */ (value);
  if (target.kind === "repository-jobs" && exactObject(target, ["kind", "controllerKey", "projectId", "repositoryId"])
    && controllerKey(target.controllerKey) && identifier(target.projectId) && identifier(target.repositoryId)) return { kind: "repository-jobs", controllerKey: target.controllerKey, projectId: target.projectId, repositoryId: target.repositoryId };
  if (target.kind === "job" && exactObject(target, ["kind", "controllerKey", "jobId"])
    && controllerKey(target.controllerKey) && jobId(target.jobId)) return { kind: "job", controllerKey: target.controllerKey, jobId: target.jobId };
  return undefined;
}
/** @param {Context} context @param {{ready:Promise<void>,open:(target:Target,isCurrent:()=>boolean)=>Promise<boolean>}} destination */
export function registerExecutionNavigation(context, destination) {
  return context.onNavigate(async (raw, isCurrent) => {
    const target = parseTarget(raw); if (!target) return invalid();
    try { await destination.ready; } catch { return { status: "unavailable", code: "load-failed", message: "Execution targets could not be loaded." }; }
    if (!isCurrent()) return unavailable();
    const opened = await destination.open(target, isCurrent);
    if (!opened) return unavailable();
    return { status: "opened", message: target.kind === "job" ? `Opened execution job ${target.jobId}.` : `Opened jobs for ${target.projectId}/${target.repositoryId}.` };
  });
}
