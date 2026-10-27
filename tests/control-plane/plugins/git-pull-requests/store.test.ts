import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, symlink, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parsePullRequest } from "@slop-lab/gs-pull-requests";
import * as repositorySdk from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { PullRequestStore } from "../../../../packages/control-plane/plugins/git-pull-requests/src/store.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "git-pr-store-")); roots.push(root); return root; }
it("durably isolates repositories and rejects path or symlink escape", async () => {
  const root = await directory(); const store = new PullRequestStore(root);
  const now = new Date().toISOString();
  const value = parsePullRequest({ schemaVersion: 1, id: randomUUID(), version: 1, title: "Persistent", body: "", sourceRef: "refs/heads/change", targetRef: "refs/heads/main", state: "open", actorId: "alice", createdAt: now, updatedAt: now, revisions: [{ id: randomUUID(), sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40), createdAt: now }], comments: [] });
  await store.save("project", "first", value);
  expect(await new PullRequestStore(root).read("project", "first", value.id)).toEqual(value);
  expect(await store.read("project", "second", value.id)).toBeUndefined();
  expect((await stat(join(root, "project", "first", `${value.id}.json`))).mode & 0o777).toBe(0o600);
  await expect(store.read("..", "first", value.id)).rejects.toThrow(/selector/);
  await mkdir(join(root, "outside"), { mode: 0o700 }); await symlink(join(root, "outside"), join(root, "escape"));
  await expect(store.read("escape", "first", value.id)).rejects.toThrow(/directories/);
  await symlink(join(root, "project", "first", `${value.id}.json`), join(root, "project", "second", `${value.id}.json`));
  await expect(store.read("project", "second", value.id)).rejects.toThrow();
});

function value() {
  const now = new Date().toISOString();
  return parsePullRequest({ schemaVersion: 1, id: randomUUID(), version: 1, title: "Persistent", body: "", sourceRef: "refs/heads/change", targetRef: "refs/heads/main", state: "open", actorId: "alice", createdAt: now, updatedAt: now, revisions: [{ id: randomUUID(), sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40), createdAt: now }], comments: [] });
}
it("validates DIM-owned identities before deriving filesystem paths or pin refs", async () => {
  const root = await directory(); const store = new PullRequestStore(root); const record = value();
  const escaped = parsePullRequest({ ...record, id: "../../escaped" });
  await expect(store.save("project", "main", escaped)).rejects.toThrow(/UUID/);
  const escapedRevision = parsePullRequest({ ...record, revisions: [{ ...record.revisions[0]!, id: "../other-pin" }] });
  await expect(store.save("project", "main", escapedRevision)).rejects.toThrow(/UUID/);
  const foreignRevision = parsePullRequest({ ...record, comments: [{ id: randomUUID(), revisionId: randomUUID(), body: "Unbound", actorId: "alice", createdAt: record.createdAt }] });
  await expect(store.save("project", "main", foreignRevision)).rejects.toThrow(/unknown revision/);
  expect(await readdir(root)).toEqual([]);
});
it("rejects an oversized UTF-8 record before replacing the readable previous version", async () => {
  const root = await directory(); const store = new PullRequestStore(root); const record = value();
  await store.save("project", "main", record);
  const oversized = parsePullRequest({ ...record, version: 2, comments: Array.from({ length: 5600 }, () => ({ id: randomUUID(), revisionId: record.revisions[0]!.id, actorId: "alice", createdAt: record.createdAt, body: "界".repeat(1000) })) });
  await expect(store.save("project", "main", oversized)).rejects.toThrow(/16 MiB/);
  expect(await store.read("project", "main", record.id)).toEqual(record);
  expect(await readdir(join(root, "project", "main"))).toEqual([`${record.id}.json`]);
});
it("publishes no owner record if an ancestor directory cannot be synced and safely retries", async () => {
  const root = await directory(); const store = new PullRequestStore(root); const record = value();
  const original = repositorySdk.syncDirectory;
  const failure = vi.spyOn(repositorySdk, "syncDirectory").mockImplementation(async (path) => {
    if (path === root) throw new Error("ancestor sync failed");
    await original(path);
  });
  await expect(store.save("project", "main", record)).rejects.toThrow(/ancestor sync/);
  expect(await store.list("project", "main")).toEqual([]);
  failure.mockRestore();
  await store.save("project", "main", record);
  expect(await new PullRequestStore(root).read("project", "main", record.id)).toEqual(record);
});
