// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebNavigationResult} NavigationResult */
/** @typedef {{controllerKey?:string,status:'ready'|'unavailable',projects:Array<{projectId:string,repositoryIds:string[]}>,operations:Array<{name:string}>}} Controller */
/** @typedef {{kind:'repository',controllerKey:string,projectId:string,repositoryId:string}|{kind:'review',controllerKey:string,projectId:string,repositoryId:string,reviewId:string}} Target */
/** @returns {NavigationResult} */
const invalid = () => ({ status: "unavailable", code: "invalid-target", message: "The navigation target is invalid." });
/** @returns {NavigationResult} */
const unavailable = () => ({ status: "unavailable", code: "target-unavailable", message: "The requested Git target is unavailable." });
/** @param {unknown} value @returns {value is string} */
const controllerKey = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
/** @param {unknown} value @returns {value is string} */
const identifier = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
/** @param {unknown} value @returns {value is string} */
const reviewId = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
  if (target.kind === "repository" && exactObject(target, ["kind", "controllerKey", "projectId", "repositoryId"])
    && controllerKey(target.controllerKey) && identifier(target.projectId) && identifier(target.repositoryId)) return { kind: "repository", controllerKey: target.controllerKey, projectId: target.projectId, repositoryId: target.repositoryId };
  if (target.kind === "review" && exactObject(target, ["kind", "controllerKey", "projectId", "repositoryId", "reviewId"])
    && controllerKey(target.controllerKey) && identifier(target.projectId) && identifier(target.repositoryId) && reviewId(target.reviewId)) return { kind: "review", controllerKey: target.controllerKey, projectId: target.projectId, repositoryId: target.repositoryId, reviewId: target.reviewId };
  return undefined;
}
/** @param {Context} context @param {{ready:Promise<void>,controllers:()=>readonly Controller[],open:(target:Target,isCurrent:()=>boolean)=>Promise<boolean>}} destination */
export function registerNativeGitNavigation(context, destination) {
  return context.onNavigate(async (raw, isCurrent) => {
    const target = parseTarget(raw); if (!target) return invalid();
    try { await destination.ready; }
    catch { if (!destination.controllers().length) return { status: "unavailable", code: "load-failed", message: "Git targets could not be loaded." }; }
    if (!isCurrent()) return unavailable();
    const controller = destination.controllers().find((entry) => entry.controllerKey === target.controllerKey);
    const project = controller?.projects.find((entry) => entry.projectId === target.projectId);
    if (!controller || controller.status !== "ready" || !project?.repositoryIds.includes(target.repositoryId)
      || !controller.operations.some(({ name }) => name === "reviews.list")) return unavailable();
    if (target.kind === "review" && !controller.operations.some(({ name }) => name === "reviews.detail")) return unavailable();
    if (!await destination.open(target, isCurrent)) return unavailable();
    return { status: "opened", message: target.kind === "review" ? `Opened review ${target.reviewId}.` : `Opened ${target.projectId}/${target.repositoryId} reviews.` };
  });
}

/** @param {HTMLElement} parent @param {HTMLElement} status @param {Context} context @param {{controllerKey?:string,projectId:string,projectName?:string,repositoryId:string,repositoryIds?:readonly string[]}} target @param {()=>boolean} isCurrent */
export function appendNativeGitNavigationActions(parent, status, context, target, isCurrent) {
  if (!target.controllerKey) return;
  const controllerKey = target.controllerKey, localProjectName = target.projectName ?? target.projectId;
  if (context.navigation.canCreateWorkspace) context.ui.navigationAction(parent, {
    label: "Create managed workspace", status, isCurrent,
    open: () => context.navigation.openWorkspaceCreate({ hostId: controllerKey, projectId: localProjectName, repositoryIds: [target.repositoryId], workingRepositoryId: target.repositoryId })
  });
  if (context.navigation.canCreateWorkspace && target.repositoryIds && target.repositoryIds.length > 1) context.ui.navigationAction(parent, {
    label: "Create workspace with all repositories", status, isCurrent,
    open: () => context.navigation.openWorkspaceCreate({ hostId: controllerKey, projectId: localProjectName, repositoryIds: target.repositoryIds ?? [target.repositoryId], workingRepositoryId: target.repositoryId })
  });
  if (context.navigation.hasFeature("execution")) context.ui.navigationAction(parent, {
    label: "View execution jobs", status, isCurrent,
    open: () => context.navigation.openFeature("execution", { kind: "repository-jobs", controllerKey, projectId: target.projectId, repositoryId: target.repositoryId })
  });
}
