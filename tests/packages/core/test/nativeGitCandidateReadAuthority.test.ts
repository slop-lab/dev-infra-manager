import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeGitCandidateReadAuthority } from "../../../../core/packages/core/src/nativeGitCandidateReadAuthority.js";
import {
  nativeGitFixture,
  type NativeGitFixture,
  type NativeGitObjectFormat
} from "../../native-git/test/nativeGitHarness.js";

const fixtures: NativeGitFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native Git candidate read authority", () => {
  it.each([
    { objectFormat: "sha1", objectIdLength: 40 },
    { objectFormat: "sha256", objectIdLength: 64 }
  ] satisfies readonly { readonly objectFormat: NativeGitObjectFormat; readonly objectIdLength: number }[])(
    "fetches an exact $objectFormat promoted candidate after its proposal advances and materializes its tree",
    async ({ objectFormat, objectIdLength }) => {
    // Given
    const fixture = await nativeGitFixture(objectFormat);
    fixtures.push(fixture);
    const clone = join(fixture.root, "writer");
    await fixture.git(fixture.root, ["clone", fixture.url("writer-a", "writer-a-secret-1", "project-a", "source"), clone]);
    await fixture.git(clone, ["config", "user.name", "DIM writer"]);
    await fixture.git(clone, ["config", "user.email", "writer@example.invalid"]);
    await mkdir(join(clone, "src"));
    await writeFile(join(clone, "src", "candidate.txt"), "candidate one\n");
    await writeFile(join(clone, "run.bash"), "#!/bin/sh\nexit 0\n");
    await chmod(join(clone, "run.bash"), 0o755);
    await fixture.git(clone, ["add", "src/candidate.txt", "run.bash"]);
    await fixture.git(clone, ["commit", "-m", "candidate one"]);
    const candidateCommit = (await fixture.git(clone, ["rev-parse", "HEAD"])).stdout.trim();
    const candidateTree = (await fixture.git(clone, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const proposal = "refs/heads/proposals/workspace-a/candidate";
    await fixture.git(clone, ["push", "origin", `HEAD:${proposal}`]);
    await fixture.git(fixture.root, ["--git-dir", fixture.repositoryPath("project-a", "source"), "update-ref", "refs/heads/main", candidateCommit]);
    await writeFile(join(clone, "src", "later.txt"), "proposal advanced\n");
    await fixture.git(clone, ["add", "src/later.txt"]);
    await fixture.git(clone, ["commit", "-m", "later"]);
    await fixture.git(clone, ["push", "origin", `HEAD:${proposal}`]);
    const temporaryRoot = join(fixture.root, "reader-temp");
    const destinationParent = join(fixture.root, "materialized");
    await mkdir(temporaryRoot, { mode: 0o700 });
    await mkdir(destinationParent, { mode: 0o700 });
    const authority = createNativeGitCandidateReadAuthority({
      gitExecutable: fixture.config.gitExecutable,
      serviceEndpoint: fixture.baseUrl,
      credential: { username: "reader-a", password: "reader-a-secret-1" },
      temporaryRoot,
      claim: {
        projectId: "project-a",
        repositoryId: "source",
        protectedRef: "refs/heads/main",
        expectedProtectedHead: candidateCommit,
        candidateCommit,
        candidateTree
      }
    });
    const destination = join(destinationParent, "tree");
    const candidateBlob = (await fixture.git(clone, ["rev-parse", `${candidateCommit}:src/candidate.txt`])).stdout.trim();
    const repositoryFormat = (await fixture.git(fixture.root, [
      "--git-dir", fixture.repositoryPath("project-a", "source"), "rev-parse", "--show-object-format"
    ])).stdout.trim();

    // When
    const protectedHead = await authority.resolveProtectedHead({
      projectId: "project-a", repositoryId: "source", protectedRef: "refs/heads/main", signal: AbortSignal.timeout(10_000)
    });
    const commit = await authority.readCommit({
      projectId: "project-a", repositoryId: "source", objectId: candidateCommit, signal: AbortSignal.timeout(10_000)
    });
    const blob = await authority.readBlob({
      projectId: "project-a", repositoryId: "source", treeObjectId: candidateTree,
      path: "src/candidate.txt", maximumBytes: 1024, signal: AbortSignal.timeout(10_000)
    });
    const result = await authority.materializeTree({
      projectId: "project-a", repositoryId: "source", commitObjectId: candidateCommit,
      treeObjectId: candidateTree, destination, signal: AbortSignal.timeout(10_000)
    });

    // Then
    const objectIdPattern = new RegExp(`^[0-9a-f]{${objectIdLength}}$`);
    expect(repositoryFormat).toBe(objectFormat);
    expect(candidateCommit).toMatch(objectIdPattern);
    expect(candidateTree).toMatch(objectIdPattern);
    expect(candidateBlob).toMatch(objectIdPattern);
    expect(protectedHead).toBe(candidateCommit);
    expect(commit).toEqual({ objectId: candidateCommit, treeObjectId: candidateTree });
    expect(blob).toEqual({ objectId: candidateBlob, mode: "100644", bytes: Buffer.from("candidate one\n") });
    expect(result).toEqual({ commitObjectId: candidateCommit, treeObjectId: candidateTree });
    await expect(readFile(join(destination, "src", "candidate.txt"), "utf8")).resolves.toBe("candidate one\n");
    expect((await stat(join(destination, "run.bash"))).mode & 0o777).toBe(0o755);
    await expect(readFile(join(destination, "src", "later.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  );
});
