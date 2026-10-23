/** Selected-host application entrypoints. Transport and operator presentations
 * remain with their callers; this module owns composition and host authority. */
export { runHostRequest, type HostApplicationDelegates } from "./host-application.js";
export { encodeHostRequest, decodeHostRequest, HostRequestError, type HostRequest } from "./protocol.js";
export { resolveWorkspaceMetadata } from "./workspace-composition.js";
export { pluginSpecs, type RequiredPlugins } from "./protocol.js";
