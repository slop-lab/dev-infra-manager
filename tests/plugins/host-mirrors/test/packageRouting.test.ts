import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, type StreamingCommandRunner } from "@slop-lab/dim-core";
import { dockerTarget, packageTarget, rewritePackageMetadata } from "../../../../plugin-host-mirrors/src/package-routing.js";
import { hostMirrorProvider, parseCacheCatalog } from "../../../../plugin-host-mirrors/src/provider.js";

it("uses the same fixed URL catalog for local, NAS and externally operated caches", () => {
  const endpoints = { docker: "https://nas.example/docker/", npm: "https://npm.example/cache/", pypi: "https://nas.example/root/pypi/+simple/", apt: "http://mirror.example:3142/" };
  expect(parseCacheCatalog({ schemaVersion: 1, endpoints })).toEqual(endpoints);
  expect(() => parseCacheCatalog({ schemaVersion: 1, endpoints, install: { command: "anything" } })).toThrow();
  expect(() => parseCacheCatalog({ schemaVersion: 1, endpoints: { ...endpoints, npm: "https://user:secret@npm.example/" } })).toThrow();
  expect(() => parseCacheCatalog({ schemaVersion: 1, endpoints: { ...endpoints, apt: "http://mirror.example/path/" } })).toThrow();
});
it("retains npm scoped package paths but prevents normalized and encoded repository escapes", () => {
  const endpoint = "https://nas.example/npm/";
  expect(packageTarget("npm", "/@scope%2fpkg", endpoint)?.href).toBe(endpoint + "@scope%2fpkg");
  for (const path of ["//other.example/", "/../admin", "/%2e%2e/admin", "/pkg/%2e%2e/admin", "/pkg%2f..%2fadmin", "/pkg\\..\\admin", "/%ZZ"]) {
    expect(packageTarget("npm", path, endpoint), path).toBeUndefined();
    if (path !== "//other.example/") expect(dockerTarget("/v2" + path, "https://nas.example/"), path).toBeUndefined();
  }
  expect(dockerTarget("/v2/library/debian/manifests/stable", "https://nas.example/docker/")?.pathname).toBe("/docker/v2/library/debian/manifests/stable");
  expect(dockerTarget("/admin", "https://nas.example/")).toBeUndefined();
});
it("rewrites npm artifact URLs within a configured repository and rejects CDN bypasses", () => {
  const endpoint = "https://nas.example/npm/";
  const result: unknown = JSON.parse(rewritePackageMetadata("npm", JSON.stringify({ versions: { "1.0": { dist: { tarball: endpoint + "pkg/-/pkg.tgz", integrity: "sha512-example" } } } }), new URL(endpoint + "pkg"), endpoint, "http://guest:8000"));
  expect(result).toMatchObject({ versions: { "1.0": { dist: { tarball: "http://guest:8000/pkg/-/pkg.tgz", integrity: "sha512-example" } } } });
  expect(() => rewritePackageMetadata("npm", '{"dist":{"tarball":"https://cdn.example/pkg.tgz"}}', new URL(endpoint), endpoint, "http://guest:8000")).toThrow(/outside/);
});
it("preserves PEP 503 hash fragments and PEP 691 hashes while relaying cached PyPI files", () => {
  const endpoint = "https://nas.example/root/pypi/+simple/", upstream = new URL(endpoint + "package/");
  const file = "https://nas.example/root/pypi/+f/abc/package.whl";
  const html = rewritePackageMetadata("pypi", `<a href="../../+f/abc/package.whl#sha256=1234">wheel</a>`, upstream, endpoint, "http://guest:8001");
  const href = /href="([^"]+)"/.exec(html)![1]!;
  expect(new URL(href).hash).toBe("#sha256=1234");
  expect(packageTarget("pypi", new URL(href).pathname, endpoint)?.href).toBe(file);
  const json: unknown = JSON.parse(rewritePackageMetadata("pypi", JSON.stringify({ files: [{ url: file, hashes: { sha256: "1234" } }] }), upstream, endpoint, "http://guest:8001"));
  expect(json).toMatchObject({ files: [{ url: `http://guest:8001/__dim/file/${encodeURIComponent(file)}`, hashes: { sha256: "1234" } }] });
  expect(packageTarget("pypi", "/__dim/file/" + encodeURIComponent("https://nas.example/admin"), endpoint)).toBeUndefined();
  expect(packageTarget("pypi", "/__dim/file/" + encodeURIComponent("https://other.example/root/pypi/+f/file"), endpoint)).toBeUndefined();
});

it("consumes server-published or explicit external URLs without invoking a deployment runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-cache-catalog-"));
  vi.stubEnv("DIM_STATE_ROOT", root);
  const endpoints = { docker: "https://nas.example/docker/", npm: "https://npm.example/cache/", pypi: "https://nas.example/root/pypi/+simple/", apt: "http://mirror.example:3142/" };
  const forbidden = async (): Promise<never> => { throw new Error("client must not invoke Docker or install servers"); };
  const runner: StreamingCommandRunner = { run: forbidden, runStreaming: forbidden };
  try {
    await atomicWrite(join(root, "services/package-caches.json"), { schemaVersion: 1, endpoints });
    const published = await hostMirrorProvider.ensure(runner);
    expect(published.dockerDaemonConfig).toContain(endpoints.docker);
    expect(published.jobFiles?.find((file) => file.target === "/etc/npmrc")?.contents).toContain(endpoints.npm);
    await atomicWrite(join(root, "plugins/host-mirrors/config.json"), { schemaVersion: 1, endpoints: { ...endpoints, npm: "https://override.example/" } });
    const explicit = await hostMirrorProvider.ensure(runner);
    expect(explicit.jobFiles?.find((file) => file.target === "/etc/npmrc")?.contents).toContain("https://override.example/");
    expect(explicit.jobEnvironmentDefaults).toEqual({ NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc" });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
