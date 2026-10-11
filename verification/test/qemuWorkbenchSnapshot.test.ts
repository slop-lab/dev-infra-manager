import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = resolve(import.meta.dirname, "../../.dim/qemu-verify.bash");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted QEMU workbench snapshot", () => {
  it("preserves canonical DIM directories as one exact Git tree", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-qemu-workbench-"));
    roots.push(root);
    const source = join(root, "source");
    const snapshot = join(root, "snapshot");
    const children = [
      "core",
      "plugin-dns-cloudflare",
      "plugin-external-urls",
      "plugin-host-mirrors",
      "tests",
      "verification",
      "examples",
      "specification"
    ];
    await mkdir(join(source, "docs", "core"), { recursive: true });
    await writeFile(join(source, "README.md"), "canonical root\n");
    await writeFile(join(source, "docs", "core", "keep.txt"), "owned by root\n");
    for (const child of children) {
      await mkdir(join(source, child));
      await writeFile(join(source, child, "marker.txt"), `${child}\n`);
    }
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
    expect(tracked).toContain("docs/core/keep.txt");
    for (const child of children) {
      expect(tracked).toContain(`${child}/marker.txt`);
      expect(await readFile(join(snapshot, child, "marker.txt"), "utf8")).toBe(`${child}\n`);
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
