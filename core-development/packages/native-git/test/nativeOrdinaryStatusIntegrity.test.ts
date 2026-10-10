import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptIssuerAuthorization,
  ordinaryStatusFixture,
  post,
  readStatusRecord,
  resultReporterAuthorization,
  statusRecordPath,
  statusReviewPath
} from "./nativeOrdinaryStatusFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";
import { reviewProposalRef } from "./nativeBundleReviewFixture.js";
import { saveAuthoritativeOrdinaryStatus } from "../../../../core/packages/native-git/src/authoritative-ordinary-status-store.js";
import { authoritativeOrdinaryTerminalEventSchema } from "../../../../core/packages/native-git/src/authoritative-ordinary-status-schema.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary status integrity", () => {
  it("rejects an unsafe status root before creating files outside the repository or changing permissions", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-status-unsafe-root");
    const external = join(fixture.root, "unrelated-private-directory");
    const root = join(rootRepository(fixture.root), "dim-authoritative-statuses");
    await mkdir(external, { mode: 0o750 });
    await chmod(external, 0o750);
    await symlink(external, root);

    // When
    const response = await post(fixture.service.origin, statusReviewPath(fixture.review.reviewId),
      fixture.event, resultReporterAuthorization);

    // Then
    expect(response.status).not.toBe(201);
    expect(await readdir(external)).toEqual([]);
    expect((await lstat(external)).mode & 0o777).toBe(0o750);
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
  }, 30_000);

  it("rejects revoked and stale local authority without publishing status evidence", async () => {
    // Given
    const revoked = await ordinaryStatusFixture("ordinary-status-revoked");
    const revokedPayload = record(revoked.event.payload);
    const revoke = await post(revoked.service.origin,
      statusReviewPath(revoked.review.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1,
        revocationRequestId: revokedPayload.attemptId,
        jobName: "source",
        attemptId: revokedPayload.attemptId
      }, attemptIssuerAuthorization);
    const stale = await ordinaryStatusFixture("ordinary-status-stale");
    stale.proof.beforeResponse = () => runGit("/usr/bin/git", ["--git-dir", rootRepository(stale.root), "update-ref",
      reviewProposalRef, String(stale.review.expectedProtectedHead)]).then(() => undefined);

    // When
    const revokedResponse = await post(revoked.service.origin, statusReviewPath(revoked.review.reviewId),
      revoked.event, resultReporterAuthorization);
    const staleResponse = await post(stale.service.origin, statusReviewPath(stale.review.reviewId),
      stale.event, resultReporterAuthorization);

    // Then
    expect(revoke.status).toBe(201);
    expect([revokedResponse.status, staleResponse.status]).toEqual([409, 409]);
    await expect(readStatusRecord(revoked.root, revoked.review.reviewId)).rejects.toThrow();
    await expect(readStatusRecord(stale.root, stale.review.reviewId)).rejects.toThrow();
  }, 45_000);

  it("rejects a corrupt immutable status during startup without mutation", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-status-corruption");
    expect((await post(fixture.service.origin, statusReviewPath(fixture.review.reviewId),
      fixture.event, resultReporterAuthorization)).status).toBe(201);
    const path = statusRecordPath(fixture.root, fixture.review.reviewId);
    await closeFinalizeService(fixture.service);
    const original = await readFile(path, "utf8");
    await chmod(path, 0o640);
    await expect(startFinalizeService(fixture.root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
    await chmod(path, 0o600);
    const alias = `${path}.alias`;
    await link(path, alias);
    await expect(startFinalizeService(fixture.root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
    await unlink(alias);
    const wrongPath = path.replace(/1\.json$/, "2.json");
    await rename(path, wrongPath);
    await expect(startFinalizeService(fixture.root)).rejects.toThrow();
    await rename(wrongPath, path);
    const malformed = `${JSON.stringify({ schemaVersion: 2, executionKind: "ordinary-sysbox" })}\n`;
    await writeFile(path, malformed);
    const before = await lstat(path);

    // When
    const restart = startFinalizeService(fixture.root);

    // Then
    await expect(restart).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(malformed);
    const after = await lstat(path);
    expect({ mode: after.mode, uid: after.uid, nlink: after.nlink }).toEqual({
      mode: before.mode, uid: before.uid, nlink: before.nlink
    });
  }, 30_000);

  it.each(["foreign-name", "symbolic-link", "foreign-hard-link", "mismatched-record", "partial-final"] as const)(
    "refuses an unsafe %s status artifact during startup without mutation",
    async (kind) => {
      // Given
      const fixture = await ordinaryStatusFixture(`ordinary-status-unsafe-${kind}`);
      await closeFinalizeService(fixture.service);
      const finalPath = statusRecordPath(fixture.root, fixture.review.reviewId);
      const directory = dirname(finalPath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let artifactPath: string;
      if (kind === "partial-final") {
        artifactPath = finalPath;
        await writeFile(artifactPath, "{", { mode: 0o600 });
      } else if (kind === "mismatched-record") {
        const event = authoritativeOrdinaryTerminalEventSchema.parse(fixture.event);
        await saveAuthoritativeOrdinaryStatus(rootRepository(fixture.root), event, "ordinary-results");
        const bytes = await readFile(finalPath);
        artifactPath = stagingPath(directory, "2.json", bytes);
        await writeFile(artifactPath, bytes, { mode: 0o600 });
      } else if (kind === "foreign-name") {
        artifactPath = join(directory, "foreign.tmp");
        await writeFile(artifactPath, "foreign evidence\n", { mode: 0o600 });
      } else {
        const foreign = join(fixture.root, `${kind}.json`);
        await writeFile(foreign, "foreign evidence\n", { mode: 0o600 });
        artifactPath = stagingPath(directory, "1.json", Buffer.from("foreign evidence\n"));
        if (kind === "symbolic-link") await symlink(foreign, artifactPath);
        else await link(foreign, artifactPath);
      }
      const before = await lstat(artifactPath);
      const bytesBefore = await readFile(artifactPath);

      // When / Then
      await expect(startFinalizeService(fixture.root)).rejects.toThrow();
      expect(await readFile(artifactPath)).toEqual(bytesBefore);
      const after = await lstat(artifactPath);
      expect({ ino: after.ino, mode: after.mode, nlink: after.nlink, size: after.size })
        .toEqual({ ino: before.ino, mode: before.mode, nlink: before.nlink, size: before.size });
    },
    30_000
  );
});

function stagingPath(directory: string, finalName: string, bytes: Buffer): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return join(directory, `.${finalName}.${digest}.${randomUUID()}.tmp`);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected record");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
