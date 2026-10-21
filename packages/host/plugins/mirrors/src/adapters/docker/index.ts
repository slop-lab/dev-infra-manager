import { cacheEndpoint, type MirrorAdapter } from "../../protocol-plugin-api.js";
import { clientConfiguration } from "./client.js";
import { repositoryTarget } from "../url.js";
export const mirrorAdapter: MirrorAdapter = {
  kind: "docker", description: "Docker Hub registry cache",
  commands: [{ name: "docker", description: "Use the configured Docker Hub cache" }],
  guestModuleUrl: new URL("./client.js", import.meta.url).href,
  normalizeEndpoint: cacheEndpoint,
  target(path, endpoint) { return /^\/v2(?:\/|$)/.test(path) ? repositoryTarget(path, endpoint) : undefined; },
  responseHeaders: ["docker-content-digest", "docker-distribution-api-version"],
  clientConfiguration
};
