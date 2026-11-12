import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateObjectError } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateObjects.js";
import { NativeGitProcessError } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateProcess.js";
import {
  nativeGitCandidateIntegrityFixture,
  type NativeGitCandidateIntegrityFixture
} from "./nativeGitCandidateIntegrityFixture.js";

const fixtures: NativeGitCandidateIntegrityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native Git candidate integrity", () => {
  it("acquires and exports selected objects without a whole-repository fsck", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitCandidate("candidate.txt", "candidate\n", "without-full-fsck");
    const instrumented = await fixture.instrumentedGit("reject-fsck");
    const authority = fixture.openReader(candidate, { gitExecutable: instrumented.executable });
    const destination = join(fixture.destinationParent, "context");

    // When
    const commit = await authority.readCommit(scope(candidate.commit));
    await authority.exportSourceContext?.({
      projectId: "project-a",
      repositoryId: "source",
      mode: "candidate-and-immediate-parents",
      destination,
      signal: AbortSignal.timeout(10_000)
    });

    // Then
    expect(commit).toEqual({ objectId: candidate.commit, treeObjectId: candidate.tree });
    await expect(readFile(join(destination, "context.json"), "utf8")).resolves.toContain(candidate.commit);
    const calls = (await readFile(instrumented.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as readonly string[]);
    expect(calls.some((args) => args.includes("fsck"))).toBe(false);
    expect(calls.some((args) => args.includes("verify-pack") || args.includes("--batch-all-objects")
      || args.includes("rev-list") && (args.includes("--all") || args.includes("--objects")))).toBe(false);
    expect(calls.some((args) => args.includes("--depth=1"))).toBe(true);
    expect(calls.some((args) => args.includes("--depth=2"))).toBe(true);
  });

  it.each(["commit", "tree", "blob"] as const)("rejects corrupted selected %s bytes", async (objectType) => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitCandidate("candidate.txt", "candidate\n", `corrupt-${objectType}`);
    const instrumented = await fixture.instrumentedGit(`corrupt-${objectType}`);
    const authority = fixture.openReader(candidate, { gitExecutable: instrumented.executable });

    // When
    const read = objectType === "commit"
      ? authority.readCommit(scope(candidate.commit))
      : authority.readBlob({
        projectId: "project-a",
        repositoryId: "source",
        treeObjectId: candidate.tree,
        path: "candidate.txt",
        maximumBytes: 1024,
        signal: AbortSignal.timeout(10_000)
      });

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateObjectError);
  });

  it("rejects a malformed pack received from upload-pack", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitCandidate("candidate.txt", "candidate\n", "malformed-pack");
    const corruptingServer = await fixture.corruptingEndpoint();
    const authority = fixture.openReader(candidate, { serviceEndpoint: corruptingServer.origin });

    // When
    const read = authority.readCommit(scope(candidate.commit));

    // Then
    await expect(read).rejects.toBeInstanceOf(NativeGitProcessError);
    expect(corruptingServer.corrupted()).toBe(true);
  });
});

async function startFixture(): Promise<NativeGitCandidateIntegrityFixture> {
  const fixture = await nativeGitCandidateIntegrityFixture();
  fixtures.push(fixture);
  return fixture;
}

function scope(objectId: string) {
  return {
    projectId: "project-a",
    repositoryId: "source",
    objectId,
    signal: AbortSignal.timeout(10_000)
  } as const;
}
