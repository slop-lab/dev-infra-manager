import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewerWebServerFromConfigFile } from "../../../../core/packages/web/src/index.js";
import { nativeGitReviewFixture, type ReviewFixture } from "../../native-git/test/nativeGitReviewHarness.js";
import { webConfig } from "./webHarness.js";

const roots: string[] = [];
const nativeFixtures: ReviewFixture[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
  await Promise.all(nativeFixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DIM reviewer web startup policy", () => {
  it("rejects a non-private or symbolic-link configuration", async () => {
    // Given
    const native = await startNative();
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const linked = join(root, "linked.json");
    const config = webConfig({ nativeBaseUrl: native.baseUrl(), publicOrigin: "http://127.0.0.1:40101", port: 40101 });
    await writeFile(target, JSON.stringify(config), { mode: 0o644 });
    await chmod(target, 0o644);
    await import("node:fs/promises").then(({ symlink }) => symlink(target, linked));

    // When / Then
    await expect(createReviewerWebServerFromConfigFile(target)).rejects.toThrow("caller-owned mode-0600 regular file");
    await chmod(target, 0o600);
    await expect(createReviewerWebServerFromConfigFile(linked)).rejects.toThrow("caller-owned mode-0600 regular file");
  });

  it("fails before bind for wrong credentials, role, or exact identity scope", async () => {
    // Given
    const native = await startNative();
    const base = webConfig({ nativeBaseUrl: native.baseUrl(), publicOrigin: "http://127.0.0.1:40102", port: 40102 });
    const cases = [
      { ...base, nativeGit: { ...objectField(base, "nativeGit"), password: "incorrect-password" } },
      { ...base, nativeGit: { ...objectField(base, "nativeGit"), username: "admin-a", password: "admin-a-secret-1" } },
      { ...base, nativeGit: { ...objectField(base, "nativeGit"), projectId: "project-b" } },
      { ...base, nativeGit: { ...objectField(base, "nativeGit"), repositoryIds: ["source", "foreign"] } },
      { ...base, nativeGit: { ...objectField(base, "nativeGit"), reviewerId: "reviewer-b" } }
    ];

    // When / Then
    for (const candidate of cases) {
      const path = await writeConfig(candidate);
      await expect(createReviewerWebServerFromConfigFile(path)).rejects.toThrow();
      await expect(fetch("http://127.0.0.1:40102/healthz")).rejects.toThrow();
    }
  });

  it("fails before bind when native identity attestation is unavailable", async () => {
    // Given
    const native = createServer((_request, response) => response.writeHead(503).end());
    native.listen(0, "127.0.0.1");
    await once(native, "listening");
    servers.push(native);
    const address = native.address();
    if (address === null || typeof address === "string") throw new Error("expected native TCP address");
    const config = webConfig({
      nativeBaseUrl: `http://127.0.0.1:${address.port}`,
      publicOrigin: "http://127.0.0.1:40103",
      port: 40103
    });
    const path = await writeConfig(config);

    // When / Then
    await expect(createReviewerWebServerFromConfigFile(path)).rejects.toThrow("identity attestation failed");
    await expect(fetch("http://127.0.0.1:40103/healthz")).rejects.toThrow();
  });
});

async function startNative(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  nativeFixtures.push(fixture);
  return fixture;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-reviewer-web-policy-"));
  roots.push(root);
  return root;
}

async function writeConfig(config: object): Promise<string> {
  const path = join(await temporaryRoot(), "config.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

function objectField(value: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  const field = value[name];
  if (typeof field !== "object" || field === null || Array.isArray(field)) throw new Error(`expected object field: ${name}`);
  return Object.fromEntries(Object.entries(field));
}
