import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { approvePullRequest, createPullRequest, createRepo, initGitHost, mergePullRequest, repoPath } from "../src/gitHost.js";
import { ProcessRunner } from "../src/runner.js";

describe("managed git host", () => {
  let root: string;
  const runner = new ProcessRunner();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-git-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates, approves, and fast-forward merges pull requests", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    await initGitHost(config);
    await createRepo(config, runner, "app");

    const worktree = join(root, "worktree");
    await run("git", ["clone", repoPath(config, "app"), worktree]);
    await run("git", ["-C", worktree, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", worktree, "config", "user.name", "Test User"]);
    await writeFile(join(worktree, "README.md"), "main\n", "utf8");
    await run("git", ["-C", worktree, "add", "README.md"]);
    await run("git", ["-C", worktree, "commit", "-m", "initial"]);
    await run("git", ["-C", worktree, "push", "origin", "HEAD:refs/heads/main"]);
    await run("git", ["-C", worktree, "checkout", "-b", "change"]);
    await writeFile(join(worktree, "README.md"), "change\n", "utf8");
    await run("git", ["-C", worktree, "commit", "-am", "change"]);
    await run("git", ["-C", worktree, "push", "origin", "HEAD:refs/heads/change"]);

    const pr = await createPullRequest(config, runner, {
      repo: "app",
      sourceRef: "refs/heads/change",
      targetRef: "refs/heads/main",
      title: "Change app",
      body: ""
    });
    expect(pr.id).toBe(1);
    await expect(mergePullRequest(config, runner, "app", pr.id)).rejects.toThrow(/no approvals/);

    await approvePullRequest(config, "app", pr.id, "reviewer");
    const merged = await mergePullRequest(config, runner, "app", pr.id);
    expect(merged.status).toBe("merged");

    const main = await runner.run("git", ["--git-dir", repoPath(config, "app"), "rev-parse", "refs/heads/main"]);
    expect(main.stdout.trim()).toBe(pr.sourceSha);
  });

  async function run(command: string, args: string[]): Promise<void> {
    const result = await runner.run(command, args);
    if (result.exitCode !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    }
  }
});
