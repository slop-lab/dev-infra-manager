import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ServerResponse } from "node:http";

const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const ASSET_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MAX_ASSET_BYTES = 512 * 1024;

type StaticAsset = {
  readonly contentType: string;
  readonly csp: string;
  readonly source: URL;
};

const assets = new Map<string, StaticAsset>([
  ["/", asset("index.html", "text/html; charset=utf-8", HTML_CSP)],
  ["/assets/tokens.css", asset("tokens.css", "text/css; charset=utf-8", ASSET_CSP)],
  ["/assets/app.css", asset("app.css", "text/css; charset=utf-8", ASSET_CSP)],
  ["/assets/app.js", asset("app.js", "text/javascript; charset=utf-8", ASSET_CSP)],
  ["/assets/review-data.js", asset("review-data.js", "text/javascript; charset=utf-8", ASSET_CSP)],
  ["/assets/review-renderer.js", asset("review-renderer.js", "text/javascript; charset=utf-8", ASSET_CSP)],
  ["/assets/operation-coordinator.js", asset("operation-coordinator.js", "text/javascript; charset=utf-8", ASSET_CSP)],
  ["/assets/patch-position.js", asset("patch-position.js", "text/javascript; charset=utf-8", ASSET_CSP)],
  ["/assets/favicon.svg", asset("favicon.svg", "image/svg+xml", ASSET_CSP)],
  ["/assets/fonts/geist-sans-latin.woff2", asset("fonts/geist-sans-latin.woff2", "font/woff2", ASSET_CSP)],
  ["/assets/fonts/geist-mono-latin.woff2", asset("fonts/geist-mono-latin.woff2", "font/woff2", ASSET_CSP)]
]);

export async function serveStaticAsset(pathname: string, response: ServerResponse): Promise<boolean> {
  const selected = assets.get(pathname);
  if (selected === undefined) return false;
  const handle = await open(selected.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new StaticAssetError("invalid packaged static asset");
    const body = await handle.readFile();
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": String(body.length),
      "Content-Security-Policy": selected.csp,
      "Content-Type": selected.contentType,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    response.end(body);
    return true;
  } finally {
    await handle.close();
  }
}

function asset(filename: string, contentType: string, csp: string): StaticAsset {
  return { contentType, csp, source: new URL(`./assets/${filename}`, import.meta.url) };
}

class StaticAssetError extends Error {
  readonly name = "StaticAssetError";
}
