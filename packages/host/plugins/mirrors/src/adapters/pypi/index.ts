import { cacheEndpoint, type MirrorAdapter } from "../../protocol-plugin-api.js";
import { clientConfiguration } from "./client.js";
import { repositoryTarget, within } from "../url.js";
export const mirrorAdapter: MirrorAdapter = {
  kind: "pypi", description: "PyPI simple-index and artifact cache",
  commands: [{ name: "pip", description: "Use the configured PyPI cache" }],
  guestModuleUrl: new URL("./client.js", import.meta.url).href,
  normalizeEndpoint: cacheEndpoint, clientConfiguration,
  target(path, endpoint) {
    if (!path.startsWith("/__dim/file/")) return repositoryTarget(path, endpoint);
    try {
      const target = new URL(decodeURIComponent(path.slice("/__dim/file/".length)));
      return within(target, new URL("../", endpoint)) && !target.username && !target.password ? target : undefined;
    } catch { return; }
  },
  metadata: {
    accepts: (type) => /json|html/i.test(type),
    rewrite(contents, { upstream, endpoint, clientOrigin }) {
      const base = new URL(endpoint);
      function local(input: string): string {
        const target = new URL(input, upstream);
        if (target.username || target.password) throw new Error("credential-bearing package URL");
        if (within(target, base)) return `${clientOrigin}/${target.href.slice(base.href.length)}`;
        if (within(target, new URL("../", base))) {
          const fragment = target.hash; target.hash = "";
          return `${clientOrigin}/__dim/file/${encodeURIComponent(target.href)}${fragment}`;
        }
        throw new Error("package cache returned an artifact outside its configured repository");
      }
      if (contents.trimStart().startsWith("{")) {
        const value: unknown = JSON.parse(contents);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid simple index metadata");
        const document = value as Record<string, unknown>;
        for (const key of ["files", "projects"]) {
          const entries = document[key];
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const item = entry as Record<string, unknown>;
            if (typeof item.url === "string") item.url = local(item.url);
          }
        }
        return JSON.stringify(document);
      }
      return contents.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (_match, quote: string, href: string) =>
        `href=${quote}${local(href.replaceAll("&amp;", "&")).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}${quote}`);
    }
  }
};
