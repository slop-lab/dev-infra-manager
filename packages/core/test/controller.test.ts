import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controllerLockPath, controllerTick } from "../src/controller.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { createRepo, repoPath } from "../src/gitHost.js";
import { ProcessRunner } from "../src/runner.js";

describe("controller", () => {
  let root: string;
  const runner = new ProcessRunner();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-controller-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deploys when approved ref changes and records state", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    await createRepo(config, runner, "trusted-runtime");
    const worktree = join(root, "trusted-runtime");
    await git(["clone", repoPath(config, "trusted-runtime"), worktree]);
    await git(["-C", worktree, "config", "user.email", "test@example.invalid"]);
    await git(["-C", worktree, "config", "user.name", "Test User"]);
    await writeFile(join(worktree, "Dockerfile"), "FROM scratch\n", "utf8");
    await git(["-C", worktree, "add", "Dockerfile"]);
    await git(["-C", worktree, "commit", "-m", "trusted runtime"]);
    await git(["-C", worktree, "push", "origin", "HEAD:refs/heads/bootstrap"]);
    await seedApprovedRef(config, worktree);

    let deployCount = 0;
    const first = await controllerTick(config, runner, false, async () => {
      deployCount += 1;
    });
    const second = await controllerTick(config, runner, false, async () => {
      deployCount += 1;
    });

    expect(first.deployed).toBe(true);
    expect(second.deployed).toBe(false);
    expect(deployCount).toBe(1);
  });

  it("refuses to deploy when controller lock is already held", async () => {
    const config = await configWithApprovedRef();
    await mkdir(controllerLockPath(config), { recursive: true });

    await expect(controllerTick(config, runner, false, async () => undefined)).rejects.toThrow(/Controller deploy lock is already held/);
  });

  it("releases controller lock after deploy failure", async () => {
    const config = await configWithApprovedRef();
    await expect(
      controllerTick(config, runner, false, async () => {
        throw new Error("deploy failed");
      })
    ).rejects.toThrow(/deploy failed/);

    let deployCount = 0;
    await controllerTick(config, runner, false, async () => {
      deployCount += 1;
    });
    expect(deployCount).toBe(1);
  });

  async function configWithApprovedRef() {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    await createRepo(config, runner, "trusted-runtime");
    const worktree = join(root, `trusted-runtime-${Math.random().toString(36).slice(2)}`);
    await git(["clone", repoPath(config, "trusted-runtime"), worktree]);
    await git(["-C", worktree, "config", "user.email", "test@example.invalid"]);
    await git(["-C", worktree, "config", "user.name", "Test User"]);
    await writeFile(join(worktree, "Dockerfile"), "FROM scratch\n", "utf8");
    await git(["-C", worktree, "add", "Dockerfile"]);
    await git(["-C", worktree, "commit", "-m", "trusted runtime"]);
    await git(["-C", worktree, "push", "origin", "HEAD:refs/heads/bootstrap"]);
    await seedApprovedRef(config, worktree);
    return config;
  }

  async function seedApprovedRef(config: ReturnType<typeof normalizeConfig>, worktree: string): Promise<void> {
    const head = await runner.run("git", ["-C", worktree, "rev-parse", "HEAD"]);
    if (head.exitCode !== 0) {
      throw new Error(`git rev-parse failed: ${head.stderr}`);
    }
    await git(["--git-dir", repoPath(config, "trusted-runtime"), "update-ref", config.secretRuntime.approvedRef, head.stdout.trim()]);
  }

  async function git(args: string[]): Promise<void> {
    const result = await runner.run("git", args);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }
});
