// @ts-check

/** @typedef {import("../plugin-api.js").WebManagedWorkspaceCreateTarget} WorkspaceTarget */
/** @typedef {import("../plugin-api.js").WebNavigationResult} NavigationResult */
/** @typedef {(target:unknown,current:()=>boolean)=>Promise<NavigationResult>} FeatureDestination */
/** @typedef {(target:WorkspaceTarget)=>NavigationResult} WorkspaceDestination */

let epoch = 0, sequence = 0, authorized = false;
export function invalidateNavigationRequests() { sequence++; }
export function navigationRevision() { return sequence; }
/** @type {Map<string,FeatureDestination>} */ const features = new Map();
/** @type {WorkspaceDestination | null} */ let workspaceDestination = null;

/** @param {import("./types.js").Session} session */
export function startNavigationSession(session) {
  epoch++; sequence++; features.clear(); workspaceDestination = null;
  authorized = session.capabilities.operations && session.roles.includes("operator");
}

export function endNavigationSession() {
  epoch++; sequence++; authorized = false; features.clear(); workspaceDestination = null;
}

/** @param {string} featureId @param {FeatureDestination} destination */
export function registerFeatureDestination(featureId, destination) {
  const selected = epoch;
  features.set(featureId, destination);
  return () => { if (selected === epoch && features.get(featureId) === destination) { features.delete(featureId); sequence++; } };
}

/** @param {WorkspaceDestination} destination */
export function registerWorkspaceDestination(destination) {
  const selected = epoch;
  workspaceDestination = destination;
  return () => { if (selected === epoch && workspaceDestination === destination) { workspaceDestination = null; sequence++; } };
}

/** @type {import("../plugin-api.js").WebPluginNavigation} */
export const navigation = Object.freeze({
  hasFeature(/** @type {string} */ featureId) { return features.has(featureId); },
  get canCreateWorkspace() { return authorized && workspaceDestination !== null; },
  async openFeature(/** @type {string} */ featureId, /** @type {unknown} */ target) {
    const selectedEpoch = epoch, selectedSequence = ++sequence, destination = features.get(featureId);
    if (!destination) return unavailable("not-installed", "This feature is not installed in navigation.");
    /** @type {NavigationResult} */ let result;
    try { result = await destination(target, () => selectedEpoch === epoch && selectedSequence === sequence); }
    catch { result = { status: "unavailable", code: "load-failed", message: "This feature could not complete navigation." }; }
    return selectedEpoch === epoch && selectedSequence === sequence
      ? result
      : unavailable("session-ended", "This navigation request ended with the browser session.");
  },
  async openWorkspaceCreate(/** @type {WorkspaceTarget} */ target) {
    const parsed = parseWorkspaceTarget(target);
    if (!parsed) return unavailable("invalid-target", "The managed workspace target is invalid.");
    if (!authorized) return unavailable("not-authorized", "This account cannot create workspaces.");
    const destination = workspaceDestination;
    if (!destination) return unavailable("target-unavailable", "Workspace creation is not available for this session.");
    const selectedEpoch = epoch, selectedSequence = ++sequence;
    /** @type {NavigationResult} */ let result;
    try { result = destination(parsed); }
    catch { result = { status: "unavailable", code: "load-failed", message: "Workspace creation could not be opened." }; }
    return selectedEpoch === epoch && selectedSequence === sequence
      ? result
      : unavailable("session-ended", "This navigation request ended with the browser session.");
  }
});

/** @param {()=>boolean} current @returns {import("../plugin-api.js").WebPluginNavigation} */
export function scopedNavigation(current) {
  /** @type {import("../plugin-api.js").WebPluginNavigation} */ const scoped = {
    hasFeature: (featureId) => current() && navigation.hasFeature(featureId),
    get canCreateWorkspace() { return current() && navigation.canCreateWorkspace; },
    openFeature: (featureId, target) => current() ? navigation.openFeature(featureId, target) : Promise.resolve(unavailable("session-ended", "This navigation context is no longer current.")),
    openWorkspaceCreate: (target) => current() ? navigation.openWorkspaceCreate(target) : Promise.resolve(unavailable("session-ended", "This navigation context is no longer current."))
  };
  return Object.freeze(scoped);
}

/** @param {unknown} value @returns {WorkspaceTarget | null} */
function parseWorkspaceTarget(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.includes("hostId") || !keys.includes("projectId") || !keys.includes("repositoryIds") || !keys.includes("workingRepositoryId")) return null;
  const target = /** @type {Record<string,unknown>} */ (value);
  if (!validId(target.hostId) || !validId(target.projectId) || !validId(target.workingRepositoryId) || !Array.isArray(target.repositoryIds)) return null;
  if (!target.repositoryIds.length || !target.repositoryIds.every(validId) || new Set(target.repositoryIds).size !== target.repositoryIds.length || !target.repositoryIds.includes(target.workingRepositoryId)) return null;
  return { hostId: target.hostId, projectId: target.projectId, repositoryIds: target.repositoryIds, workingRepositoryId: target.workingRepositoryId };
}

/** @param {unknown} value @returns {value is string} */
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }

/** @param {"not-installed"|"not-authorized"|"invalid-target"|"target-unavailable"|"session-ended"} code @param {string} message @returns {NavigationResult} */
function unavailable(code, message) { return { status: "unavailable", code, message }; }
