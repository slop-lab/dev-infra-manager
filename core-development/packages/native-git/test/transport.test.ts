import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isExitError, nativeGitFixture, refValue, type NativeGitFixture } from "./nativeGitHarness.js";

const fixtures: NativeGitFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git smart-HTTP transport", () => {
  it("clones only repositories registered to the authenticated Project reader", async () => {
    // Given
    const fixture = await startFixture();
    const clone = join(fixture.root, "reader-clone");

    // When
    await fixture.git(fixture.root, ["clone", fixture.url("reader-a", "reader-a-secret-1", "project-a", "source"), clone]);

    // Then
    await expect(fixture.git(clone, ["show", "HEAD:README.md"])).resolves.toMatchObject({ stdout: "project-a-initial\n" });
    await expect(fixture.git(fixture.root, ["ls-remote", fixture.url("reader-a", "reader-a-secret-1", "project-b", "source")]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /not found/.test(error.stderr));
  });

  it("allows an authorized workspace writer to create and fetch its proposal ref", async () => {
    // Given
    const fixture = await startFixture();
    const clone = await writerClone(fixture, "writer-clone");
    await commit(fixture, clone, "proposal.txt", "candidate\n");

    // When
    await fixture.git(clone, ["push", "origin", "HEAD:refs/heads/proposals/workspace-a/change-1"]);

    // Then
    const proposal = await refValue(fixture.repositoryPath("project-a", "source"), "refs/heads/proposals/workspace-a/change-1");
    expect(proposal).toMatch(/^[0-9a-f]{40}$/);
    await expect(fixture.git(clone, ["fetch", "origin", "refs/heads/proposals/workspace-a/change-1"])).resolves.toBeDefined();
  });

  it("denies direct, forced, and deletion updates to a protected ref without changing it", async () => {
    // Given
    const fixture = await startFixture();
    const clone = await writerClone(fixture, "protected-clone");
    const bare = fixture.repositoryPath("project-a", "source");
    const before = await refValue(bare, "refs/heads/main");
    await commit(fixture, clone, "protected.txt", "unreviewed\n");

    // When / Then
    await expect(fixture.git(clone, ["push", "origin", "HEAD:refs/heads/main"]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
    await fixture.git(clone, ["checkout", "--orphan", "rewritten-main"]);
    await fixture.git(clone, ["rm", "-rf", "."]);
    await commit(fixture, clone, "replacement.txt", "replacement\n");
    await expect(fixture.git(clone, ["push", "--force", "origin", "HEAD:refs/heads/main"]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
    await expect(fixture.git(clone, ["push", "origin", ":refs/heads/main"]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
    expect(await refValue(bare, "refs/heads/main")).toBe(before);
  });

  it("denies another workspace namespace and unsafe tag refs without changing refs", async () => {
    // Given
    const fixture = await startFixture();
    const clone = await writerClone(fixture, "unsafe-ref-clone");
    await commit(fixture, clone, "unsafe.txt", "unsafe\n");
    const bare = fixture.repositoryPath("project-a", "source");

    // When / Then
    await expect(fixture.git(clone, ["push", "origin", "HEAD:refs/heads/proposals/workspace-other/stolen"]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
    await expect(fixture.git(clone, ["push", "origin", "HEAD:refs/tags/unreviewed"]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /remote rejected/.test(error.stderr));
    expect(await refValue(bare, "refs/heads/proposals/workspace-other/stolen")).toBeUndefined();
    expect(await refValue(bare, "refs/tags/unreviewed")).toBeUndefined();
  });

  it("denies reader push, missing credentials, wrong credentials, traversal, and unknown repositories", async () => {
    // Given
    const fixture = await startFixture();
    const readerClone = join(fixture.root, "reader-push-clone");
    await fixture.git(fixture.root, ["clone", fixture.url("reader-a", "reader-a-secret-1", "project-a", "source"), readerClone]);
    await commit(fixture, readerClone, "reader.txt", "denied\n");

    // When / Then
    await expect(fixture.git(readerClone, ["push", "origin", "HEAD:refs/heads/proposals/workspace-a/reader"]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /403/.test(error.stderr));
    const missing = await fetch(`${fixture.baseUrl}/v1/projects/project-a/repositories/source.git/info/refs?service=git-upload-pack`);
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${fixture.baseUrl}/v1/projects/project-a/repositories/source.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Basic ${Buffer.from("reader-a:wrong").toString("base64")}` }
    });
    expect(wrong.status).toBe(401);
    const traversal = await fetch(`${fixture.baseUrl}/v1/projects/project-a/repositories/%2e%2e%2fsource.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Basic ${Buffer.from("reader-a:reader-a-secret-1").toString("base64")}` }
    });
    expect(traversal.status).toBe(404);
    await expect(fixture.git(fixture.root, ["ls-remote", fixture.url("reader-a", "reader-a-secret-1", "project-a", "missing")]))
      .rejects.toSatisfy((error: unknown) => isExitError(error) && /not found/.test(error.stderr));
  });
});

async function startFixture(): Promise<NativeGitFixture> {
  const fixture = await nativeGitFixture();
  fixtures.push(fixture);
  return fixture;
}

async function writerClone(fixture: NativeGitFixture, name: string): Promise<string> {
  const clone = join(fixture.root, name);
  await fixture.git(fixture.root, ["clone", fixture.url("writer-a", "writer-a-secret-1", "project-a", "source"), clone]);
  await fixture.git(clone, ["config", "user.name", "DIM writer"]);
  await fixture.git(clone, ["config", "user.email", "writer@example.invalid"]);
  return clone;
}

async function commit(fixture: NativeGitFixture, clone: string, file: string, content: string): Promise<void> {
  await mkdir(clone, { recursive: true });
  await writeFile(join(clone, file), content);
  await fixture.git(clone, ["add", file]);
  await fixture.git(clone, ["commit", "-m", file]);
}
