import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  saveAuthoritativeOrdinaryStatus,
  saveAuthoritativeOrdinaryStatusWithFaults,
  type AuthoritativeOrdinaryStatusPublicationFaults
} from "../../../../core/packages/native-git/src/authoritative-ordinary-status-store.js";
import { authoritativeOrdinaryTerminalEventSchema } from "../../../../core/packages/native-git/src/authoritative-ordinary-status-schema.js";
import {
  ordinaryStatusFixture,
  statusRecordPath
} from "./nativeOrdinaryStatusFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary status crash consistency", () => {
  it.each(["beforeWrite", "beforeFileSync"] as const)(
    "leaves no visible final after a kill at %s and permits a safe retry after restart",
    async (phase) => {
      // Given
      const fixture = await ordinaryStatusFixture(`ordinary-status-crash-${phase}`);
      await closeFinalizeService(fixture.service);
      const repository = rootRepository(fixture.root);
      const event = authoritativeOrdinaryTerminalEventSchema.parse(fixture.event);
      const faults: AuthoritativeOrdinaryStatusPublicationFaults = {
        [phase]: () => { throw new InjectedStatusCrashError(phase); }
      };

      // When
      await expect(saveAuthoritativeOrdinaryStatusWithFaults(repository, event, {
        reporterUsername: "ordinary-results", faults
      }))
        .rejects.toEqual(new InjectedStatusCrashError(phase));

      // Then
      const finalPath = statusRecordPath(fixture.root, fixture.review.reviewId);
      await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
      const stagedPath = await onlyStagedPath(finalPath);
      const stagedBefore = await lstat(stagedPath);
      expect(stagedBefore.mode & 0o777).toBe(0o600);
      expect(stagedBefore.nlink).toBe(1);
      if (phase === "beforeWrite") expect(stagedBefore.size).toBe(0);
      else expect(stagedBefore.size).toBeGreaterThan(0);

      const restarted = await startFinalizeService(fixture.root);
      await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
      const retried = await saveAuthoritativeOrdinaryStatus(repository, event, "ordinary-results");
      expect(retried.created).toBe(true);
      expect((await lstat(finalPath)).nlink).toBe(1);
      await closeFinalizeService(restarted);
    }
  );

  it("restores one complete same-inode final after a kill following publication", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-status-crash-after-publish");
    await closeFinalizeService(fixture.service);
    const repository = rootRepository(fixture.root);
    const event = authoritativeOrdinaryTerminalEventSchema.parse(fixture.event);
    const faults: AuthoritativeOrdinaryStatusPublicationFaults = {
      afterPublish: () => { throw new InjectedStatusCrashError("afterPublish"); }
    };

    // When
    await expect(saveAuthoritativeOrdinaryStatusWithFaults(repository, event, {
      reporterUsername: "ordinary-results", faults
    }))
      .rejects.toEqual(new InjectedStatusCrashError("afterPublish"));

    // Then
    const finalPath = statusRecordPath(fixture.root, fixture.review.reviewId);
    const stagedPath = await onlyStagedPath(finalPath);
    const finalBefore = await lstat(finalPath);
    const stagedBefore = await lstat(stagedPath);
    const bytesBefore = await readFile(finalPath);
    expect({ finalInode: finalBefore.ino, stagedInode: stagedBefore.ino, links: finalBefore.nlink })
      .toEqual({ finalInode: stagedBefore.ino, stagedInode: stagedBefore.ino, links: 2 });

    const restarted = await startFinalizeService(fixture.root);
    const finalAfter = await lstat(finalPath);
    expect(await readFile(finalPath)).toEqual(bytesBefore);
    expect({ inode: finalAfter.ino, links: finalAfter.nlink, mtimeMs: finalAfter.mtimeMs })
      .toEqual({ inode: finalBefore.ino, links: 1, mtimeMs: finalBefore.mtimeMs });
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    const replay = await saveAuthoritativeOrdinaryStatus(repository, event, "ordinary-results");
    expect(replay.created).toBe(false);
    expect((await lstat(finalPath)).mtimeMs).toBe(finalAfter.mtimeMs);
    expect((await readdir(dirname(finalPath))).filter((entry) => entry.startsWith(".1.json."))).toEqual([]);
    await closeFinalizeService(restarted);
  });
});

async function onlyStagedPath(finalPath: string): Promise<string> {
  const directory = dirname(finalPath);
  const entries = (await readdir(directory)).filter((entry) => entry.startsWith(".1.json."));
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (entry === undefined) throw new TestSetupError();
  return join(directory, entry);
}

class InjectedStatusCrashError extends Error {
  readonly name = "InjectedStatusCrashError";
  constructor(readonly phase: string) { super(`injected status crash at ${phase}`); }
}

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
