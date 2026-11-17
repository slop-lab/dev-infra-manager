import { cacheEndpoint, type MirrorAdapter } from "../../protocol-plugin-api.js";
import { clientConfiguration } from "./client.js";
import { repositoryTarget } from "../url.js";
// No `metadata` rewrite: the relay forwards a fixed `publicHosts` Host to the cache (relay.ts),
// so verdaccio's own Host-derived `dist.tarball` URLs are already guest-reachable; packuments stream through unmodified.
export const mirrorAdapter: MirrorAdapter = {
  kind: "npm", description: "npm package registry cache",
  commands: [{ name: "npm", description: "Use the configured npm cache" }],
  guestModuleUrl: new URL("./client.js", import.meta.url).href,
  normalizeEndpoint: cacheEndpoint, target: repositoryTarget, clientConfiguration
};
