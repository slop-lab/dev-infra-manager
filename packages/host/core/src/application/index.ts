/** Selected-host application entrypoints own command presentation, composition
 * and host authority. The independent CLI owns connection transport. */
export { executeHostOperation, type HostOperationRequest } from "./host-application.js";
export { runCliHostRequest, hostProtocolCapabilities } from "./cli-host.js";
export { resolveWorkspaceMetadata } from "./workspace-composition.js";
export { pluginSpecs, type RequiredPlugins } from "./workspace-plugin-specs.js";
