import { cacheEndpoint, mirrorAdapterExtension, type MirrorAdapter } from "@slop-lab/dim-host-plugin-mirrors/protocol-plugin-api";
import { clientConfiguration } from "./futureMirrorGuestClient.js";

/** A third-party artifact imports the public SDK rather than source-private modules. */
export const mirrorAdapter: MirrorAdapter = {
  kind: "future",
  description: "Disposable packaging-only future protocol fixture",
  commands: [{ name: "future-fetch", description: "Fixture protocol command metadata" }],
  guestModuleUrl: new URL("./futureMirrorGuestClient.js", import.meta.url).href,
  normalizeEndpoint: cacheEndpoint,
  target(requestPath, endpoint) {
    if (!requestPath.startsWith("/future/") || requestPath.includes("..")) return;
    const target = new URL(requestPath.slice("/future/".length), endpoint);
    return target.origin === new URL(endpoint).origin ? target : undefined;
  },
  clientConfiguration
};
export const hostPlugin = {
  name: "future-mirror-adapter",
  extensions: [mirrorAdapterExtension("future", new URL("./futureMirrorAdapter.js", import.meta.url))]
};
