import { cacheEndpoint, type MirrorAdapter } from "../../adapter.js";
import { clientConfiguration } from "./client.js";
const hosts = new Set(["deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com"]);
export const mirrorAdapter: MirrorAdapter = {
  kind: "apt", description: "APT HTTP package cache",
  commands: [{ name: "apt", description: "Use the configured APT cache" }],
  guestModuleUrl: new URL("./client.js", import.meta.url).href,
  normalizeEndpoint(value) {
    const endpoint = cacheEndpoint(value);
    if (new URL(endpoint).pathname !== "/") throw new Error("APT cache endpoint must have a root path");
    return endpoint;
  },
  target(path) {
    try {
      const target = new URL(path);
      if (target.protocol !== "http:" || target.username || target.password || target.port || target.hash || !hosts.has(target.hostname)) return;
      return target;
    } catch { return; }
  },
  requestPath: (target) => target.href,
  clientConfiguration
};
