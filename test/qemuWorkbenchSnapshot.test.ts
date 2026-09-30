import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = resolve(import.meta.dirname, "../../project/.dim/qemu-verify.bash");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted QEMU workbench snapshot", () => {
  it("keeps split repositories out of the development Git tree", async () => {
    // Given: the trusted launcher receives an assembled workbench, not a clean
    // development-only directory.
    const root = await mkdtemp(join(tmpdir(), "dim-qemu-workbench-"));
    roots.push(root);
    const source = join(root, "source");
    const snapshot = join(root, "snapshot");
    const children = ["project", "core", "core-development"];
    await mkdir(join(source, "docs", "core"), { recursive: true });
    await writeFile(join(source, "README.md"), "development root\n");
    await writeFile(join(source, "docs", "core", "keep.txt"), "owned by development\n");
    for (const child of children) {
      await mkdir(join(source, child));
      await writeFile(join(source, child, "marker.txt"), `${child}\n`);
      runGit(["init", "--initial-branch=main", join(source, child)], root);
    }
    const script = await readFile(launcher, "utf8");
    const snapshotFunction = /^snapshot_repository\(\) \{[\s\S]*?^\}/m.exec(script)?.[0];
    if (snapshotFunction === undefined) throw new TypeError("trusted snapshot function is missing");

    // When: execute the launcher's actual snapshot function before replacing
    // each independently owned child repository.
    const run = spawnSync("bash", ["-c", `set -euo pipefail\nrepo_root="$1"\ncomponents=(${children.join(" ")})\n${snapshotFunction}\nsnapshot_repository "$1" "$2"`, "snapshot", source, snapshot], {
      encoding: "utf8", env: { ...process.env, GIT_MASTER: "1" }
    });
    expect(run.status, run.stderr).toBe(0);

    // Then: parent Git owns only its own files, including nested directories
    // whose names coincide with a child repository name.
    const tracked = runGit(["ls-tree", "-r", "--name-only", "HEAD"], snapshot).split("\n");
    expect(tracked).toContain("docs/core/keep.txt");
    for (const child of children) {
      expect(tracked.some((path) => path.startsWith(`${child}/`))).toBe(false);
      expect(runGit(["check-ignore", `${child}/marker.txt`], snapshot).trim()).toBe(`${child}/marker.txt`);
      await rm(join(snapshot, child), { recursive: true });
      runGit(["init", "--initial-branch=main", join(snapshot, child)], root);
      await writeFile(join(snapshot, child, "marker.txt"), `${child}\n`);
    }
    expect(runGit(["status", "--porcelain"], snapshot)).toBe("");
  });
});

function runGit(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_MASTER: "1" }
  });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr}`);
  return result.stdout;
}
