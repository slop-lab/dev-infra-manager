import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = resolve(import.meta.dirname, "../qemu/qemu-verify.bash");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted QEMU workbench snapshot", () => {
  it("archives only the resolved committed DIM tree", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-qemu-workbench-"));
    roots.push(root);
    const source = join(root, "source");
    const snapshot = join(root, "snapshot");
    const children = ["packages", "tests", "scripts", "examples", "docs"
    ];
    await mkdir(join(source, "docs", "core"), { recursive: true });
    await writeFile(join(source, "README.md"), "canonical root\n");
    await writeFile(join(source, "docs", "core", "keep.txt"), "owned by root\n");
    for (const child of children) {
      await mkdir(join(source, child), { recursive: true });
      await writeFile(join(source, child, "marker.txt"), `${child}\n`);
    }
    runGit(["init", "--initial-branch=main"], source);
    runGit(["config", "user.name", "Snapshot Test"], source);
    runGit(["config", "user.email", "snapshot@example.invalid"], source);
    await writeFile(join(source, ".gitignore"), "ignored-secret\ntracked-ignored-source\n");
    await writeFile(join(source, "tracked-ignored-source"), "reviewed tracked source\n");
    await writeFile(join(source, "scripts", "committed-helper.bash"), "committed helper\n");
    runGit(["add", "-A"], source);
    runGit(["add", "--force", "tracked-ignored-source"], source);
    runGit(["commit", "-m", "reviewed snapshot"], source);
    const sourceCommit = runGit(["rev-parse", "HEAD"], source);
    await writeFile(join(source, "untracked-secret"), "untracked\n");
    await writeFile(join(source, "ignored-secret"), "ignored\n");
    const script = await readFile(launcher, "utf8");
    const snapshotFunction = /^snapshot_repository\(\) \{[\s\S]*?^\}/m.exec(script)?.[0];
    if (snapshotFunction === undefined) throw new TypeError("trusted snapshot function is missing");

    // When
    const run = spawnSync("bash", ["-c", `set -euo pipefail\nrepo_root="$1"\ncomponents=(${children.join(" ")})\n${snapshotFunction}\nsnapshot_repository "$1" "$2"`, "snapshot", source, snapshot], {
      encoding: "utf8", env: { ...process.env, GIT_MASTER: "1" }
    });
    expect(run.status, run.stderr).toBe(0);

    // Then
    const tracked = runGit(["ls-tree", "-r", "--name-only", "HEAD"], snapshot).split("\n");
    expect(runGit(["branch", "--show-current"], snapshot).trim()).toBe("main");
    expect(runGit(["log", "-1", "--format=%B"], snapshot)).toContain(sourceCommit);
    expect(tracked).toContain("scripts/committed-helper.bash");
    expect(tracked).toContain("tracked-ignored-source");
    expect(tracked).not.toContain("untracked-secret");
    expect(tracked).not.toContain("ignored-secret");
    expect(tracked).toContain("docs/core/keep.txt");
    for (const child of children) {
      expect(tracked).toContain(`${child}/marker.txt`);
      expect(await readFile(join(snapshot, child, "marker.txt"), "utf8")).toBe(`${child}\n`);
    }
    expect(runGit(["status", "--porcelain"], snapshot).trim()).toBe("");
    await expect(readFile(join(snapshot, "untracked-secret"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(snapshot, "ignored-secret"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function runGit(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_MASTER: "1" }
  });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr}`);
  return result.stdout;
}
