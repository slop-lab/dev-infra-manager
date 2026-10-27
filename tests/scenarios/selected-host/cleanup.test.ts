import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { cleanupOwnedSmokeWorkspace } from "./cleanup.js";
import type { CommandResult } from "../web-lifecycle/process.js";

const owned = { name: "dim-smoke-cleanup", id: "12345678-1234-4234-8234-123456789abc" };
const branch = { ref: `refs/heads/smoke/${"b".repeat(32)}`, commit: "a".repeat(40) };
const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

it("deletes only the exact expected remote commit before discarding the immutable owned workspace", async () => {
  const calls: string[][] = [];
  await cleanupOwnedSmokeWorkspace({ host: "fixture", owned, branch, run: async (args) => {
    calls.push([...args]);
    return args.includes("ls-remote") ? { ...ok, stdout: `${branch.commit}\t${branch.ref}\n` } : ok;
  } });
  expect(calls).toEqual([
    ["exec", owned.name, "--", "git", "ls-remote", "--exit-code", "--refs", "origin", branch.ref],
    ["exec", owned.name, "--", "git", "push", `--force-with-lease=${branch.ref}:${branch.commit}`, "origin", `:${branch.ref}`],
    ["discard", owned.name, "--yes", "--expect-id", owned.id, "--json"],
  ]);
});

it.each(["changed-before-read", "changed-after-read", "unavailable"] as const)("retains the workspace when branch ownership is %s", async (mode) => {
  const calls: string[][] = [];
  await expect(cleanupOwnedSmokeWorkspace({ host: "fixture", owned, branch, run: async (args) => {
    calls.push([...args]);
    if (args.includes("ls-remote")) return { ...ok, exitCode: mode === "unavailable" ? 128 : 0,
      stdout: `${mode === "changed-before-read" ? "c".repeat(40) : branch.commit}\t${branch.ref}\n` };
    return { ...ok, exitCode: 1 }; // Git rejects the exact lease if the branch advanced after readback.
  } })).rejects.toThrow(/retained for operator inspection/);
  expect(calls.some((args) => args[0] === "discard")).toBe(false);
  if (mode === "changed-after-read") expect(calls[1]).toContain(`--force-with-lease=${branch.ref}:${branch.commit}`);
  else expect(calls).toHaveLength(1);
});

it("discards an exactly owned workspace when its owned remote branch is already absent", async () => {
  const calls: string[][] = [];
  await cleanupOwnedSmokeWorkspace({ host: "fixture", owned, branch, run: async (args) => {
    calls.push([...args]); return { ...ok, exitCode: args.includes("ls-remote") ? 2 : 0 };
  } });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["discard", owned.name, "--yes", "--expect-id", owned.id, "--json"]);
});

it("performs no destructive operation for an unproven workspace identity", async () => {
  let called = false;
  await expect(cleanupOwnedSmokeWorkspace({ host: "fixture", owned: { ...owned, id: "invalid" }, branch,
    run: async () => { called = true; return ok; } })).rejects.toThrow(/ownership could not be proven/);
  expect(called).toBe(false);
});


it("real Git refuses a raced branch deletion and preserves the workspace for inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-smoke-cleanup-")), work = join(root, "work"), remote = join(root, "remote.git");
  const exec = promisify(execFile);
  const git = (args: readonly string[]) => exec("/usr/bin/git", [...args], { timeout: 10_000, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid"
  } });
  let discarded = false;
  try {
    await git(["init", "--quiet", work]);
    await git(["-C", work, "commit", "--allow-empty", "-m", "first"]);
    const first = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
    await git(["-C", work, "commit", "--allow-empty", "-m", "second"]);
    const second = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
    await git(["clone", "--bare", work, remote]);
    await git(["--git-dir", remote, "update-ref", branch.ref, first]);
    await git(["-C", work, "remote", "add", "origin", remote]);
    await expect(cleanupOwnedSmokeWorkspace({ host: "fixture", owned, branch: { ...branch, commit: first }, run: async (args) => {
      if (args[0] === "discard") { discarded = true; return ok; }
      if (args.includes("push")) await git(["--git-dir", remote, "update-ref", branch.ref, second]);
      try { const result = await git(["-C", work, ...args.slice(4)]); return { ...ok, stdout: result.stdout }; }
      catch { return { ...ok, exitCode: 1 }; }
    } })).rejects.toThrow(/retained for operator inspection/);
    expect(discarded).toBe(false);
    expect((await git(["--git-dir", remote, "rev-parse", branch.ref])).stdout.trim()).toBe(second);
  } finally { await rm(root, { recursive: true, force: true }); }
});
