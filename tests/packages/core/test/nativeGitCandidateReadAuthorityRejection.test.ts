import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeGitCandidateReadAuthority,
  NativeGitCandidateReadError
} from "../../../../core/packages/core/src/nativeGitCandidateReadAuthority.js";
import { CandidateObjectError } from "../../../../core/packages/core/src/nativeGitCandidateObjects.js";
import { NativeGitProcessError } from "../../../../core/packages/core/src/nativeGitCandidateProcess.js";
import { candidateReadFixture, type CandidateReadFixture } from "./nativeGitCandidateReadFixture.js";

const fixtures: CandidateReadFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.native.close()));
});

describe("native Git candidate read authority rejection", () => {
  it("rejects an unreachable candidate object", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitFile("unpublished.txt", "not pushed\n");
    const authority = fixture.authority(candidate);

    // When
    const read = authority.readCommit(scope(fixture, candidate.commit));

    // Then
    await expect(read).rejects.toBeInstanceOf(NativeGitProcessError);
  });

  it("rejects a foreign repository candidate object", async () => {
    // Given
    const fixture = await startFixture();
    const foreignCommit = (await fixture.native.git(fixture.native.root, [
      "--git-dir", fixture.native.repositoryPath("project-b", "source"), "rev-parse", "refs/heads/main"
    ])).stdout.trim();
    const foreignTree = (await fixture.native.git(fixture.native.root, [
      "--git-dir", fixture.native.repositoryPath("project-b", "source"), "rev-parse", `${foreignCommit}^{tree}`
    ])).stdout.trim();
    const authority = fixture.authority({ commit: foreignCommit, tree: foreignTree });

    // When
    const read = authority.readCommit(scope(fixture, foreignCommit));

    // Then
    await expect(read).rejects.toBeInstanceOf(NativeGitProcessError);
  });

  it("rejects a forged commit-to-tree binding", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitFile("candidate.txt", "candidate\n");
    await fixture.push(candidate.commit, "forged-tree");
    const initialTree = (await fixture.native.git(fixture.clone, ["rev-parse", `${fixture.initialHead}^{tree}`])).stdout.trim();
    const authority = fixture.authority({ commit: candidate.commit, tree: initialTree });

    // When
    const read = authority.readCommit(scope(fixture, candidate.commit));

    // Then
    await expect(read).rejects.toBeInstanceOf(NativeGitCandidateReadError);
  });

  it("rejects an oversized candidate tree without publishing a destination", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitFile("large.txt", "0123456789abcdef\n");
    await fixture.push(candidate.commit, "oversized");
    const authority = fixture.authority(candidate, { maximumBlobBytes: 8 });
    const destination = join(fixture.destinationParent, "oversized");

    // When
    const materialize = authority.materializeTree(materializeScope(fixture, candidate, destination));

    // Then
    await expect(materialize).rejects.toBeInstanceOf(CandidateObjectError);
    expect(await readdir(fixture.destinationParent)).toEqual([]);
  });

  it("rejects a symbolic-link tree entry without traversing it", async () => {
    // Given
    const fixture = await startFixture();
    await symlink("../README.md", join(fixture.clone, "escape"));
    await fixture.native.git(fixture.clone, ["add", "escape"]);
    await fixture.native.git(fixture.clone, ["commit", "-m", "symlink"]);
    const candidate = await currentCandidate(fixture);
    await fixture.push(candidate.commit, "symlink");
    const authority = fixture.authority(candidate);

    // When
    const materialize = authority.materializeTree(materializeScope(
      fixture, candidate, join(fixture.destinationParent, "symlink")
    ));

    // Then
    await expect(materialize).rejects.toBeInstanceOf(CandidateObjectError);
    expect(await readdir(fixture.destinationParent)).toEqual([]);
  });

  it("rejects a gitlink tree entry", async () => {
    // Given
    const fixture = await startFixture();
    await fixture.native.git(fixture.clone, [
      "update-index", "--add", "--cacheinfo", `160000,${fixture.initialHead},nested-repository`
    ]);
    await fixture.native.git(fixture.clone, ["commit", "-m", "gitlink"]);
    const candidate = await currentCandidate(fixture);
    await fixture.push(candidate.commit, "gitlink");
    const authority = fixture.authority(candidate);

    // When
    const materialize = authority.materializeTree(materializeScope(
      fixture, candidate, join(fixture.destinationParent, "gitlink")
    ));

    // Then
    await expect(materialize).rejects.toBeInstanceOf(CandidateObjectError);
  });

  it("rejects unsafe blob paths and leaves no reader repository or credential behind", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitFile("safe.txt", "safe\n");
    await fixture.push(candidate.commit, "unsafe-path");
    const authority = fixture.authority(candidate);

    // When
    const read = authority.readBlob({
      projectId: "project-a", repositoryId: "source", treeObjectId: candidate.tree,
      path: "../README.md", maximumBytes: 1024, signal: AbortSignal.timeout(10_000)
    });

    // Then
    await expect(read).rejects.toBeInstanceOf(CandidateObjectError);
    expect(await readdir(fixture.temporaryRoot)).toEqual([]);
  });

  it("rejects an existing destination before writing candidate bytes", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitFile("safe.txt", "safe\n");
    await fixture.push(candidate.commit, "existing-destination");
    const destination = join(fixture.destinationParent, "existing");
    await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, "owned.txt"), "owned\n");
    const authority = fixture.authority(candidate);

    // When
    const materialize = authority.materializeTree(materializeScope(fixture, candidate, destination));

    // Then
    await expect(materialize).rejects.toBeInstanceOf(CandidateObjectError);
  });

  it("rejects a protected head that changed after the claim was issued", async () => {
    // Given
    const fixture = await startFixture();
    const candidate = await fixture.commitFile("moved.txt", "moved\n");
    await fixture.push(candidate.commit, "moved-protected-head");
    await fixture.native.git(fixture.native.root, [
      "--git-dir", fixture.native.repositoryPath("project-a", "source"),
      "update-ref", "refs/heads/main", candidate.commit
    ]);
    const authority = fixture.authority(candidate);

    // When
    const materialize = authority.materializeTree(materializeScope(
      fixture, candidate, join(fixture.destinationParent, "moved")
    ));

    // Then
    await expect(materialize).rejects.toBeInstanceOf(NativeGitCandidateReadError);
  });

  it("rejects credentials embedded in the native Git service URL", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const create = () => createNativeGitCandidateReadAuthority({
      gitExecutable: fixture.native.config.gitExecutable,
      serviceEndpoint: fixture.native.baseUrl.replace("http://", "http://reader-a:reader-a-secret-1@"),
      credential: { username: "reader-a", password: "reader-a-secret-1" },
      temporaryRoot: fixture.temporaryRoot,
      claim: {
        projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main",
        expectedProtectedHead: fixture.initialHead, candidateCommit: fixture.initialHead,
        candidateTree: "0000000000000000000000000000000000000000"
      }
    });

    // Then
    expect(create).toThrow(NativeGitCandidateReadError);
  });

  it("rejects a claim whose object identifiers use different formats", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const create = () => createNativeGitCandidateReadAuthority({
      gitExecutable: fixture.native.config.gitExecutable,
      serviceEndpoint: fixture.native.baseUrl,
      credential: { username: "reader-a", password: "reader-a-secret-1" },
      temporaryRoot: fixture.temporaryRoot,
      claim: {
        projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main",
        expectedProtectedHead: fixture.initialHead, candidateCommit: "a".repeat(64),
        candidateTree: "b".repeat(64)
      }
    });

    // Then
    expect(create).toThrow(NativeGitCandidateReadError);
  });

  it("rejects a SHA-256 claim presented for a SHA-1 repository", async () => {
    // Given
    const fixture = await startFixture();
    const authority = createNativeGitCandidateReadAuthority({
      gitExecutable: fixture.native.config.gitExecutable,
      serviceEndpoint: fixture.native.baseUrl,
      credential: { username: "reader-a", password: "reader-a-secret-1" },
      temporaryRoot: fixture.temporaryRoot,
      claim: {
        projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main",
        expectedProtectedHead: "a".repeat(64), candidateCommit: "b".repeat(64),
        candidateTree: "c".repeat(64)
      }
    });

    // When
    const resolve = authority.resolveProtectedHead({
      projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main",
      signal: AbortSignal.timeout(10_000)
    });

    // Then
    await expect(resolve).rejects.toBeInstanceOf(NativeGitCandidateReadError);
  });

  it("bounds SHA-256 candidate materialization without publishing a destination", async () => {
    // Given
    const fixture = await candidateReadFixture("sha256");
    fixtures.push(fixture);
    const candidate = await fixture.commitFile("large.txt", "0123456789abcdef\n");
    await fixture.push(candidate.commit, "sha256-oversized");
    const authority = fixture.authority(candidate, { maximumBlobBytes: 8 });
    const destination = join(fixture.destinationParent, "sha256-oversized");

    // When
    const materialize = authority.materializeTree(materializeScope(fixture, candidate, destination));

    // Then
    await expect(materialize).rejects.toBeInstanceOf(CandidateObjectError);
    expect(await readdir(fixture.destinationParent)).toEqual([]);
  });
});

async function startFixture(): Promise<CandidateReadFixture> {
  const fixture = await candidateReadFixture();
  fixtures.push(fixture);
  return fixture;
}

async function currentCandidate(fixture: CandidateReadFixture): Promise<{ readonly commit: string; readonly tree: string }> {
  return {
    commit: (await fixture.native.git(fixture.clone, ["rev-parse", "HEAD"])).stdout.trim(),
    tree: (await fixture.native.git(fixture.clone, ["rev-parse", "HEAD^{tree}"])).stdout.trim()
  };
}

function scope(fixture: CandidateReadFixture, objectId: string) {
  return {
    projectId: "project-a",
    repositoryId: "source",
    objectId,
    signal: AbortSignal.timeout(10_000)
  } as const;
}

function materializeScope(
  _fixture: CandidateReadFixture,
  candidate: { readonly commit: string; readonly tree: string },
  destination: string
) {
  return {
    projectId: "project-a",
    repositoryId: "source",
    commitObjectId: candidate.commit,
    treeObjectId: candidate.tree,
    destination,
    signal: AbortSignal.timeout(10_000)
  } as const;
}
