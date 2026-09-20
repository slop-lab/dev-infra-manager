import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];

function git(arguments_: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return spawnSync("git", arguments_, { cwd, env, encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stateful SSH managed Git policy", () => {
  it("resolves the checkout remote when the SSH session starts in its home directory", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-ssh-managed-git-"));
    temporaryRoots.push(root);
    const remote = resolve(root, "remote.git");
    const checkout = resolve(root, "workspace");
    const home = resolve(root, "home");
    await mkdir(home);
    expect(git(["init", "--bare", remote], root).status).toBe(0);
    expect(git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], root).status).toBe(0);
    expect(git(["init", "--initial-branch=main", checkout], root).status).toBe(0);
    expect(git(["config", "user.name", "DIM Test"], checkout).status).toBe(0);
    expect(git(["config", "user.email", "dim@example.invalid"], checkout).status).toBe(0);
    await writeFile(resolve(checkout, "README.md"), "managed Git fixture\n");
    expect(git(["add", "README.md"], checkout).status).toBe(0);
    expect(git(["commit", "-m", "fixture"], checkout).status).toBe(0);
    expect(git(["remote", "add", "origin", remote], checkout).status).toBe(0);
    expect(git(["push", "origin", "main"], checkout).status).toBe(0);
    const env = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: checkout,
      GIT_CONFIG_KEY_2: "safe.directory",
      GIT_CONFIG_VALUE_2: `${checkout}/*`,
      GIT_TERMINAL_PROMPT: "0"
    };

    // When
    const homeRelative = git(["ls-remote", "origin", "HEAD"], home, env);
    const checkoutRelative = git(["-C", checkout, "ls-remote", "origin", "HEAD"], home, env);
    const smoke = await readFile(resolve(workspaceRoot, "verification/scripts/stateful-development-flow-smoke.bash"), "utf8");

    // Then
    expect(homeRelative.status).toBe(128);
    expect(checkoutRelative.status, checkoutRelative.stderr).toBe(0);
    expect(checkoutRelative.stdout).toMatch(/^[0-9a-f]{40}\s+HEAD$/m);
    expect(smoke).toContain("GIT_TERMINAL_PROMPT=0 git -C /workspace ls-remote origin HEAD >/dev/null");
  });
});
