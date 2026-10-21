import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { webPlugin, operations } from "../../../../packages/web/plugins/native-git/src/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { promoter?: boolean; sync?: boolean; stale?: boolean; wrongRole?: boolean; wrongReviewer?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-web-plugin-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const generationId = "a".repeat(64), calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    if (req.url === "/v1/human-reviewer-identity") return res.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: options.wrongRole ? "host-promoter" : "human-reviewer", reviewerId: options.wrongReviewer ? "foreign" : "owner", generationId }));
    if (req.url === "/v1/host-promoter-identity") return res.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "host-promoter", hostId: "devbox", generationId }));
    if (req.url === "/v1/git-sync-operator-identity") return res.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "git-sync-operator", hostId: "devbox", generationId }));
    if (req.url?.endsWith("/reviews")) return res.end("[]");
    if (req.url?.endsWith("/sync/publish")) {
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`sync:${"s".repeat(43)}`).toString("base64")}`);
      expect(req.headers["x-dim-generation-id"]).toBe(generationId);
      return res.end(JSON.stringify({ schemaVersion: 1, outcome: "published", sourceCommit: "b".repeat(40), targetRef: "refs/heads/development" }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}`, reviewerConnection = join(root, "reviewer.json"), promoterConnection = join(root, "promoter.json"), syncConnection = join(root, "sync.json");
  await writeFile(reviewerConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl, generationId: options.stale ? "c".repeat(64) : generationId, reviewerId: "owner", username: "reviewer", password: "p".repeat(43) }), { mode: 0o600 });
  await writeFile(promoterConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: baseUrl, generationId, role: "host-promoter", hostId: "devbox", credential: { username: "promoter", password: "p".repeat(43) } }), { mode: 0o600 });
  await writeFile(syncConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: baseUrl, generationId, role: "git-sync-operator", hostId: "devbox", credential: { username: "sync", password: "s".repeat(43) } }), { mode: 0o600 });
  return { calls, reviewerConnection, config: { reviewerConnection, projectId: "project-a", repositoryIds: ["public", "private"], ...(options.promoter ? { promoterConnection } : {}), ...(options.sync ? { syncConnection } : {}) } };
}
it("attests configured reviewer, exposes scoped repositories and omits unconfigured authority", async () => {
  const selected = await fixture(); const runtime = await webPlugin.create(selected.config);
  expect(await runtime.invoke("repositories.list", {})).toEqual({ projectId: "project-a", repositoryIds: ["public", "private"], reviewerId: "owner" });
  expect(await runtime.invoke("reviews.list", { repositoryId: "public" })).toEqual([]);
  expect(runtime.operations?.map((operation) => operation.name)).not.toContain("reviews.promote");
  expect(runtime.operations?.some((operation) => operation.name.startsWith("sync."))).toBe(false);
  await expect(runtime.invoke("reviews.list", { repositoryId: "foreign" })).rejects.toThrow("scope");
  expect(selected.calls).toEqual(["GET /v1/human-reviewer-identity", "GET /v1/projects/project-a/repositories/public/reviews"]);
});
it("rejects a stale serving identity and public connection files before enabling review", async () => {
  const stale = await fixture({ stale: true }); await expect(webPlugin.create(stale.config)).rejects.toThrow("identity");
  const publicFile = await fixture(); await chmod(publicFile.reviewerConnection, 0o644);
  await expect(webPlugin.create(publicFile.config)).rejects.toThrow("mode-0600");
});
it("attests optional authorities and publishes only through scoped exact operator endpoint", async () => {
  const selected = await fixture({ promoter: true, sync: true }), runtime = await webPlugin.create(selected.config);
  expect(runtime.operations?.map((operation) => operation.name)).toContain("reviews.promote");
  expect(await runtime.invoke("sync.publish", { repositoryId: "private" })).toMatchObject({ outcome: "published", targetRef: "refs/heads/development" });
  expect(selected.calls).toContain("POST /v1/projects/project-a/repositories/private/sync/publish");
  await expect(runtime.invoke("sync.publish", { repositoryId: "foreign" })).rejects.toThrow("scope");
});
it("rejects browser-supplied service paths and strips non-public review evidence", () => {
  const listing = operations.find((operation) => operation.name === "reviews.list")!;
  expect(() => listing.parseInput({ repositoryId: "public", projectId: "foreign" })).toThrow();
  expect(() => listing.parseInput({ repositoryId: "../private" })).toThrow();
  expect(() => listing.parseOutput([{ reviewId: "a".repeat(64), proposalRef: "refs/proposal/a", protectedRef: "refs/heads/main", candidateCommit: "b".repeat(40), createdAt: new Date().toISOString(), status: "approved", password: "secret" }])).toThrow();
});

it("rejects wrong serving role and reviewer identities before loading browser review operations", async () => {
  for (const options of [{ wrongRole: true }, { wrongReviewer: true }]) {
    const selected = await fixture(options);
    await expect(webPlugin.create(selected.config)).rejects.toThrow();
    expect(selected.calls).toEqual(["GET /v1/human-reviewer-identity"]);
  }
});
