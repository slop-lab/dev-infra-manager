import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createProjectReviewMatcher } from "../../../examples/features/security-review/project-matcher.ts";
import type { AuthoritativeNativeChangedPath } from "../../../packages/control-plane/plugins/code-review/src/authoritative-native-review-schema.ts";
const source = await readFile(new URL("../../../examples/features/security-review/repository/.dim/review/matcher.mjs", import.meta.url), "utf8");
function change(path: string): AuthoritativeNativeChangedPath {
  return { status: "modified", oldPath: path, newPath: path, oldPathBytes: Buffer.from(path).toString("base64"), newPathBytes: Buffer.from(path).toString("base64"), oldMode: "100644", newMode: "100644", oldObjectId: "a".repeat(40), newObjectId: "b".repeat(40) };
}
describe("project-owned review matcher", () => {
  it("unconditionally guards evaluator changes before reading or running candidate code", async () => {
    const matcher = await createProjectReviewMatcher({ revision: "e".repeat(64), execute: async () => { throw Error("must not execute"); } });
    for (const path of [".dim/security-boundary.json", ".dim/workspace.json", ".dim", ".dim/review/matcher.mjs", ".dim/review/dependency.mjs", ".dim/review/settings.json", ".dim/review"]) {
      expect(await matcher.matches({ options: {}, changes: [change(path)], readCandidateFile: async () => { throw Error("must not read"); }, readBlob: async () => { throw Error("must not read"); } })).toBe(true);
    }
    const renamed = { ...change("ordinary.txt"), oldPath: ".dim/review/matcher.mjs" };
    expect(await matcher.matches({ options: {}, changes: [renamed], readCandidateFile: async () => { throw Error("must not read"); }, readBlob: async () => { throw Error("must not read"); } })).toBe(true);
  });
  it("passes candidate evaluator and exact changed contents to the isolated executor", async () => {
    const matcher = await createProjectReviewMatcher({ revision: "e".repeat(64), execute: async (input) => { expect(input.source).toBe(source); expect(input.changes).toEqual([{ oldPath: "app/config.json", newPath: "app/config.json", before: "before", after: "after" }]); return false; } });
    expect(await matcher.matches({ options: {}, changes: [change("app/config.json")], readCandidateFile: async (path) => { expect(path).toBe(".dim/review/matcher.mjs"); return Buffer.from(source); }, readBlob: async (id) => Buffer.from(id.startsWith("a") ? "before" : "after") })).toBe(false);
  });
  it("rejects missing evaluator, oversized data and evaluator failure", async () => {
    const matcher = await createProjectReviewMatcher({ revision: "e".repeat(64), execute: async () => { throw Error("sandbox failed"); } });
    const input = { options: {}, changes: [change("app/config.json")], readBlob: async () => Buffer.from("{}") };
    await expect(matcher.matches({ ...input, readCandidateFile: async () => undefined })).rejects.toThrow("missing");
    await expect(matcher.matches({ ...input, readCandidateFile: async () => Buffer.alloc(65 * 1024) })).rejects.toThrow("64 KiB");
    await expect(matcher.matches({ ...input, readCandidateFile: async () => Buffer.from(source), readBlob: async () => Buffer.alloc(129 * 1024) })).rejects.toThrow("changed-content");
    await expect(matcher.matches({ ...input, readCandidateFile: async () => Buffer.from(source) })).rejects.toThrow("sandbox failed");
    expect(() => matcher.validate({ command: "bypass" })).toThrow("empty object");
  });
  it("binds custom executor semantics to an explicit revision", async () => {
    const execute = async () => false;
    await expect(createProjectReviewMatcher({ execute, revision: "unversioned" })).rejects.toThrow("SHA256 revision");
    const first = await createProjectReviewMatcher({ execute, revision: "a".repeat(64) });
    const second = await createProjectReviewMatcher({ execute, revision: "b".repeat(64) });
    expect(first.revision).not.toBe(second.revision);
  });
  it("example business rules distinguish appearance from execution access", async () => {
    // This imports only the fixed, reviewed example fixture, never a candidate.
    const fixture = await import("../../../examples/features/security-review/repository/.dim/review/matcher.mjs");
    expect(fixture.matches([{ newPath: "app/config.json", before: '{"theme":"light"}', after: '{"theme":"dark"}' }])).toBe(false);
    expect(fixture.matches([{ newPath: "app/config.json", before: '{"allowHostAccess":false}', after: '{"allowHostAccess":true}' }])).toBe(true);
    expect(() => fixture.matches([{ newPath: "app/config.json", after: '{broken' }])).toThrow();
  });
});

describe("retain-files ref policy", () => {
  it("validates a small literal path list", async () => {
    const { createRetainFilesRefPolicy } = await import("../../../examples/features/security-review/ref-policy.ts");
    const policy = await createRetainFilesRefPolicy();
    expect(() => policy.validate({ paths: [".dim/review/matcher.mjs", "file[1].json"] })).not.toThrow();
    for (const options of [{ paths: [] }, { paths: ["../escape"] }, { paths: ["/absolute"] }, { paths: ["a//b"] }, { paths: ["a", "a"] }, { paths: ["x"], bypass: true }]) expect(() => policy.validate(options)).toThrow("normalized relative paths");
  });
  it("inspects immutable Git trees, rejecting deletion and symlink but allowing reviewed content updates", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdir, mkdtemp, rm, writeFile, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { assertGitVersion } = await import("../../../packages/control-plane/plugins/git-repositories/src/repository.ts");
    const { assertRetainedFiles } = await import("../../../examples/features/security-review/ref-policy.ts");
    const exec = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), "dim-retain-files-"));
    const run = (args: string[]) => exec("/usr/bin/git", args, { env: { HOME: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
    try {
      const version = (await run(["--version"])).stdout.trim().replace(/^git version /, "");
      const gitIdentity = await assertGitVersion({ gitExecutable: "/usr/bin/git", gitVersion: version });
      await run(["init", root]);
      const file = join(root, "guard[1].mjs");
      await writeFile(file, "first"); await writeFile(join(root, "guard1.mjs"), "unrelated");
      const tree = async () => { await run(["-C", root, "add", "."]); return (await run(["-C", root, "write-tree"])).stdout.trim(); };
      const check = async () => assertRetainedFiles({ gitExecutable: "/usr/bin/git", gitIdentity, repository: join(root, ".git"), candidateTree: await tree(), options: { paths: ["guard[1].mjs"] } });
      await expect(check()).resolves.toBeUndefined();
      await writeFile(file, "second"); await expect(check()).resolves.toBeUndefined();
      await rm(file); await expect(check()).rejects.toThrow("without regular file");
      await symlink("guard1.mjs", file); await expect(check()).rejects.toThrow("without regular file");
      await rm(file); await mkdir(file); await writeFile(join(file, "nested"), "directory");
      await expect(check()).rejects.toThrow("without regular file");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
