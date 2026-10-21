import { cacheEndpoint, type MirrorAdapter } from "../../protocol-plugin-api.js";
import { clientConfiguration } from "./client.js";
import { repositoryTarget, within } from "../url.js";
export const mirrorAdapter: MirrorAdapter = {
  kind: "npm", description: "npm package registry cache",
  commands: [{ name: "npm", description: "Use the configured npm cache" }],
  guestModuleUrl: new URL("./client.js", import.meta.url).href,
  normalizeEndpoint: cacheEndpoint, target: repositoryTarget, clientConfiguration,
  metadata: {
    accepts: (type) => /json/i.test(type),
    rewrite(contents, { upstream, endpoint, clientOrigin }) {
      const base = new URL(endpoint), value: unknown = JSON.parse(contents);
      function visit(input: unknown): void {
        if (!input || typeof input !== "object") return;
        if (Array.isArray(input)) { for (const child of input) visit(child); return; }
        const object = input as Record<string, unknown>;
        if (object.dist && typeof object.dist === "object" && !Array.isArray(object.dist)) {
          const dist = object.dist as Record<string, unknown>;
          if (typeof dist.tarball === "string") {
            const target = new URL(dist.tarball, upstream);
            if (target.username || target.password || !within(target, base)) throw new Error("package cache returned an artifact outside its configured repository");
            dist.tarball = `${clientOrigin}/${target.href.slice(base.href.length)}`;
          }
        }
        for (const child of Object.values(object)) visit(child);
      }
      visit(value); return JSON.stringify(value);
    }
  }
};
