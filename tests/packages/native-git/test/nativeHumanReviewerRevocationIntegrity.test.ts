import { randomUUID } from "node:crypto";
import { chmod, link, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native human revocation storage integrity", () => {
  it.each([
    ["wrong mode", async (record: string) => chmod(record, 0o640), /mode-0600/],
    ["wrong path", async (record: string) => rename(record, `${record}.moved`), /record name is invalid/],
    ["hard link", async (record: string) => {
      const aliasRoot = await createFinalizeRoot("revocation-hardlink-alias");
      await link(record, join(aliasRoot, "revocation-alias.json"));
    }, /single.link|link count/i]
  ] as const)("rejects revocation storage with %s at startup without repair", async (_label, mutate, message) => {
    const fixture = await revokedFixture(`revocation-${_label.replace(" ", "-")}`);
    const before = await readFile(fixture.record);
    await mutate(fixture.record);
    await closeFinalizeService(fixture.service);

    await expect(startFinalizeService(fixture.root)).rejects.toThrow(message);
    if (_label !== "wrong path") expect(await readFile(fixture.record)).toEqual(before);
  });

  it("rejects an orphan revocation and duplicate active approvals at startup", async () => {
    const orphan = await revokedFixture("revocation-orphan");
    await unlink(orphan.approvalRecord);
    await closeFinalizeService(orphan.service);
    await expect(startFinalizeService(orphan.root)).rejects.toThrow(/no matching approval/);

    const duplicate = await revokedFixture("revocation-duplicate-active");
    await approve(duplicate.endpoint, randomUUID());
    await unlink(duplicate.record);
    await closeFinalizeService(duplicate.service);
    await expect(startFinalizeService(duplicate.root)).rejects.toThrow(/approval is duplicated/);
  });
});

async function revokedFixture(label: string): Promise<{
  readonly root: string;
  readonly service: Awaited<ReturnType<typeof nativeBundleReviewFixture>>["service"];
  readonly endpoint: string;
  readonly record: string;
  readonly approvalRecord: string;
}> {
  const fixture = await nativeBundleReviewFixture(label);
  const { review } = await createBundleReview(fixture.service);
  const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`;
  const approval = await approve(endpoint, randomUUID());
  const revocation = await fetch(`${endpoint}/revocations`, { method: "POST", headers: jsonHeaders(),
    body: JSON.stringify({ approvalId: approval.approvalId }) });
  expect(revocation.status).toBe(201);
  const revocationBody: unknown = await revocation.json();
  const repository = rootRepository(fixture.root);
  return {
    root: fixture.root,
    service: fixture.service,
    endpoint,
    record: join(repository, "dim-authoritative-revocations", "records",
      `${stringField(revocationBody, "revocationId")}.json`),
    approvalRecord: join(repository, "dim-authoritative-approvals", "records", `${approval.approvalId}.json`)
  };
}

async function approve(endpoint: string, requestId: string): Promise<{ readonly approvalId: string }> {
  const response = await fetch(`${endpoint}/approvals`, { method: "POST", headers: jsonHeaders(),
    body: JSON.stringify({ requestId }) });
  expect(response.status).toBe(201);
  return { approvalId: stringField(await response.json(), "approvalId") };
}

function jsonHeaders(): Record<string, string> {
  return { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId,
    "content-type": "application/json" };
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IntegrityFixtureError();
  const selected = Reflect.get(value, field);
  if (typeof selected !== "string") throw new IntegrityFixtureError();
  return selected;
}

class IntegrityFixtureError extends Error {
  readonly name = "IntegrityFixtureError";
}
