import type { CacheKind } from "./cache-routing.js";
/** A package cache must serve its own artifacts; upstream/CDN escapes are rejected. */
function within(target: URL, base: URL): boolean { return target.origin === base.origin && target.pathname.startsWith(base.pathname); }
function safePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  try {
    const decoded = decodeURIComponent(path.split("?", 1)[0]!);
    return !decoded.includes("\\") && !decoded.split("/").some((part) => part === "." || part === "..");
  } catch { return false; }
}
export function dockerTarget(path: string, endpoint: string): URL | undefined {
  if (!safePath(path)) return;
  const base = new URL(endpoint), target = new URL(path.slice(1), base);
  return within(target, base) && /^v2(?:\/|$)/.test(target.pathname.slice(base.pathname.length)) ? target : undefined;
}
export function packageTarget(kind: CacheKind, path: string, endpoint: string): URL | undefined {
  const base = new URL(endpoint);
  if (path.startsWith("/__dim/file/")) {
    if (kind !== "pypi") return;
    try { const target = new URL(decodeURIComponent(path.slice("/__dim/file/".length)));
      const repository = new URL("../", base);
      return within(target, repository) && !target.username && !target.password ? target : undefined;
    } catch { return; }
  }
  if (!safePath(path)) return;
  const target = new URL(path.slice(1), base);
  return within(target, base) ? target : undefined;
}
export function rewritePackageMetadata(kind: "npm" | "pypi", contents: string, upstream: URL, endpoint: string, clientOrigin: string): string {
  const base = new URL(endpoint);
  function local(input: string): string {
    const target = new URL(input, upstream);
    if (target.username || target.password) throw new Error("credential-bearing package URL");
    if (within(target, base)) return `${clientOrigin}/${target.href.slice(base.href.length)}`;
    if (kind === "pypi" && within(target, new URL("../", base))) {
      const fragment = target.hash; target.hash = "";
      return `${clientOrigin}/__dim/file/${encodeURIComponent(target.href)}${fragment}`;
    }
    throw new Error("package cache returned an artifact outside its configured repository");
  }
  if (kind === "npm") {
    const value: unknown = JSON.parse(contents);
    function visit(input: unknown): void {
      if (!input || typeof input !== "object") return;
      if (Array.isArray(input)) { for (const value of input) visit(value); return; }
      const object = input as Record<string, unknown>;
      if (object.dist && typeof object.dist === "object" && !Array.isArray(object.dist)) {
        const dist = object.dist as Record<string, unknown>;
        if (typeof dist.tarball === "string") dist.tarball = local(dist.tarball);
      }
      for (const value of Object.values(object)) visit(value);
    }
    visit(value); return JSON.stringify(value);
  }
  if (contents.trimStart().startsWith("{")) {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid simple index metadata");
    const document = value as Record<string, unknown>;
    for (const key of ["files", "projects"]) {
      const entries = document[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const item = entry as Record<string, unknown>;
          if (typeof item.url === "string") item.url = local(item.url);
        }
      }
    }
    return JSON.stringify(document);
  }
  // PEP 503 links are attributes, not arbitrary text. Preserve hash fragments.
  return contents.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (_match, quote: string, href: string) => `href=${quote}${local(href.replaceAll("&amp;", "&")).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}${quote}`);
}
