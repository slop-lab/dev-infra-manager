import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAuthoritativeNativeReviewEnvelope, type AuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js";
import { assertAuthoritativeNativeReviewStore, readAuthoritativeNativeReviewEnvelopes, saveAuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js";
import * as storage from "../../../../packages/control-plane/plugins/git-review/src/review-record-storage.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "dim-review-store-")); roots.push(root); return root;
}
function envelope(name: string) {
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  return createAuthoritativeNativeReviewEnvelope({ identity: {
    schemaVersion: 2, serviceId: "native-main", projectId: "project", repositoryId: "main", inputs: { main: snapshot },
    protectedRef: "refs/heads/main", proposalRef: `refs/heads/${name}`, expectedProtectedHead: "1".repeat(40),
    candidateCommit: snapshot.commit, candidateTree: snapshot.tree, policyRevision: "4".repeat(64),
    requiredReviewRevision: "5".repeat(64), requiredReviewerIds: [], changes: [], patch: "", patchBytes: ""
  }, policyDigest: "6".repeat(64), attachments: [], createdAt: "2026-10-25T00:00:00.000Z" });
}
function recordPath(root: string, selected: AuthoritativeNativeReviewEnvelope) {
  return join(root, "dim-authoritative-reviews", "proposals", `${selected.review.reviewId}.${selected.envelopeId}.json`);
}

it("loads each historical envelope once for listing and fully validates each explicit store audit", async () => {
  const root = await repository(), first = envelope("first"), second = envelope("second");
  await saveAuthoritativeNativeReviewEnvelope(root, first);
  await saveAuthoritativeNativeReviewEnvelope(root, second);
  const reads = vi.spyOn(storage, "readReviewJson");
  expect(await readAuthoritativeNativeReviewEnvelopes(root)).toEqual(expect.arrayContaining([first, second]));
  expect(reads).toHaveBeenCalledTimes(2);
  reads.mockClear();
  await assertAuthoritativeNativeReviewStore(root);
  expect(reads).toHaveBeenCalledTimes(2);
});

it("publishes an exact new envelope without parsing unrelated corrupt bodies while full inspection rejects them", async () => {
  const root = await repository(), historical = envelope("historical"), selected = envelope("selected");
  await saveAuthoritativeNativeReviewEnvelope(root, historical);
  await writeFile(recordPath(root, historical), "{", "utf8");
  const reads = vi.spyOn(storage, "readReviewJson");
  expect(await saveAuthoritativeNativeReviewEnvelope(root, selected)).toEqual(selected);
  expect(reads).not.toHaveBeenCalled();
  expect(await saveAuthoritativeNativeReviewEnvelope(root, selected)).toEqual(selected);
  expect(reads).toHaveBeenCalledTimes(1);
  await expect(saveAuthoritativeNativeReviewEnvelope(root, historical)).rejects.toThrow();
  await expect(assertAuthoritativeNativeReviewStore(root)).rejects.toThrow();
  await expect(readAuthoritativeNativeReviewEnvelopes(root)).rejects.toThrow();
  expect(await readFile(recordPath(root, historical), "utf8")).toBe("{");
});

it.each(["foreign-name", "private-mode"])("rejects %s metadata before targeted publication", async (kind) => {
  const root = await repository(), historical = envelope("historical"), selected = envelope("selected");
  await saveAuthoritativeNativeReviewEnvelope(root, historical);
  if (kind === "foreign-name") await writeFile(join(root, "dim-authoritative-reviews", "proposals", "foreign.json"), "{}", { mode: 0o600 });
  else await chmod(recordPath(root, historical), 0o640);
  await expect(saveAuthoritativeNativeReviewEnvelope(root, selected)).rejects.toThrow();
  await expect(readFile(recordPath(root, selected))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["malformed-json", "changed-digest"])("rejects an existing exact record with %s without replacing it", async (kind) => {
  const root = await repository(), selected = envelope("selected");
  await saveAuthoritativeNativeReviewEnvelope(root, selected);
  const bytes = kind === "malformed-json" ? "{" : JSON.stringify({ ...selected, review: { ...selected.review, patch: "tampered" } });
  await writeFile(recordPath(root, selected), bytes, "utf8");
  await expect(saveAuthoritativeNativeReviewEnvelope(root, selected)).rejects.toThrow();
  expect(await readFile(recordPath(root, selected), "utf8")).toBe(bytes);
});

it("validates the exact canonical identity when publication races an existing record", async () => {
  const root = await repository(), historical = envelope("historical"), selected = envelope("selected");
  await saveAuthoritativeNativeReviewEnvelope(root, historical);
  vi.spyOn(storage, "publishReviewRecord").mockImplementation(async ({ path }) => {
    await writeFile(path, JSON.stringify(historical), { mode: 0o600 });
    throw Object.assign(new Error("competing publication"), { code: "EEXIST" });
  });
  await expect(saveAuthoritativeNativeReviewEnvelope(root, selected)).rejects.toThrow("path conflicts with its identity");
  expect(JSON.parse(await readFile(recordPath(root, selected), "utf8"))).toEqual(historical);
});
