import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkspaceSource } from "../../../../packages/host/core/src/workspace/source.js";
import { ProcessRunner } from "../../../../packages/host/core/src/runner.js";

const roots: string[] = [];
const runner = new ProcessRunner();
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "dim-source-"));
  roots.push(root);
  const source = join(root, "host checkout");
  await mkdir(source);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "DIM source test");
  await git(source, "config", "user.email", "dim-source@example.test");
  await writeFile(join(source, "README.md"), "committed source\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "Initial source");
  return { root, source, destination: join(root, "staging"), commit: await git(source, "rev-parse", "HEAD") };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runner.run("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("independent workspace Git source", () => {
  it("checks out the committed local branch without modifying or linking the host checkout", async () => {
    const { source, destination, commit } = await repository();
    await writeFile(join(source, "README.md"), "host edits stay here\n");
    await writeFile(join(source, "private-untracked"), "host-only\n");
    const snapshot = await acquireWorkspaceSource({ source: { url: source }, destination });

    expect(snapshot).toEqual({ url: source, ref: "refs/heads/main", commit });
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("committed source\n");
    expect(await readdir(destination)).not.toContain("private-untracked");
    expect(await git(destination, "branch", "--show-current")).toBe("main");
    expect(await git(destination, "remote")).toBe("");
    const objectPath = join(".git", "objects", commit.slice(0, 2), commit.slice(2));
    const hostObject = await stat(join(source, objectPath));
    // Transport cloning packs the independent destination objects rather than
    // linking the host's loose objects or borrowing an alternate object store.
    expect(hostObject.nlink).toBe(1);
    await expect(readFile(join(destination, ".git", "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(destination, "README.md"), "workspace changes\n");
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("host edits stay here\n");
  });

  it("selects a requested branch and keeps a portable upstream without copying host Git config", async () => {
    const { source, destination } = await repository();
    await git(source, "checkout", "-b", "feature/source");
    await writeFile(join(source, "feature"), "branch-specific\n");
    await git(source, "add", "feature");
    await git(source, "commit", "-m", "Feature source");
    const commit = await git(source, "rev-parse", "HEAD");
    await git(source, "checkout", "main");
    await git(source, "remote", "add", "origin", "git@example.test:team/source.git");
    await git(source, "config", "credential.helper", "host-private-helper");
    await git(source, "config", "http.extraHeader", "Authorization: host-secret");

    const snapshot = await acquireWorkspaceSource({ source: { url: source, ref: "feature/source" }, destination });

    expect(snapshot.ref).toBe("refs/heads/feature/source");
    expect(snapshot.commit).toBe(commit);
    expect(await readFile(join(destination, "feature"), "utf8")).toBe("branch-specific\n");
    expect(await git(destination, "remote", "get-url", "origin")).toBe("git@example.test:team/source.git");
    const config = await readFile(join(destination, ".git", "config"), "utf8");
    expect(config).not.toContain("host-private-helper");
    expect(config).not.toContain("host-secret");
    expect(config).not.toContain(source);
  });

  it("drops credential-bearing local upstreams instead of passing them into the workspace", async () => {
    const { source, destination } = await repository();
    await git(source, "remote", "add", "origin", "https://token-secret@example.test/team/source.git");
    await acquireWorkspaceSource({ source: { url: source }, destination });
    expect(await git(destination, "remote")).toBe("");
  });

  it("does not run host checkout filters against repository-controlled files", async () => {
    const { root, source, destination } = await repository();
    await writeFile(join(source, ".gitattributes"), "README.md filter=host-only\n");
    await git(source, "add", ".gitattributes");
    await git(source, "commit", "-m", "Candidate attributes");
    const hostHome = join(root, "host-home");
    await mkdir(hostHome);
    const marker = join(root, "host-filter-ran");
    await writeFile(join(hostHome, ".gitconfig"), `[filter "host-only"]\n  smudge = "touch ${marker}; cat"\n  required = true\n`);
    const hostRunner = {
      run(command: string, args: string[], options: Parameters<ProcessRunner["run"]>[2]) {
        return runner.run(command, args, { ...options, env: { ...options?.env, HOME: hostHome } });
      }
    };

    await acquireWorkspaceSource({ source: { url: source }, destination, runner: hostRunner });

    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("committed source\n");
  });

  it("cleans a failed acquisition and leaves an existing destination alone", async () => {
    const { source, destination } = await repository();
    await expect(acquireWorkspaceSource({ source: { url: source, ref: "missing-branch" }, destination })).rejects.toThrow(/fetch source ref/);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "owned by caller\n");
    await expect(acquireWorkspaceSource({ source: { url: source }, destination })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("owned by caller\n");
  });

  it.each([
    "https://user:secret@example.test/team/repo.git",
    "https://secret@example.test/team/repo.git",
    "https://example.test/repo.git?token=secret",
    "ext::sh -c dangerous"
  ])("rejects credentials or command transports in %s", async (url) => {
    await expect(acquireWorkspaceSource({ source: { url }, destination: "/unused" })).rejects.toThrow(/Source/);
  });
});
