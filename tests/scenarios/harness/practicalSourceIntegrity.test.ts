import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { reconstructPracticalSource } from "../../../scripts/ci/practical-source.js";
import { gitWholeStoreFence } from "../../support/gitWholeStoreFence.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-practical-integrity-")), repository = join(root, "original");
  await mkdir(repository);
  const git = (...args: string[]) => {
    const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repository, "source.txt"), "selected source\n"); git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "parent");
  const parent = git("rev-parse", "HEAD");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "candidate");
  const commit = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
  const workspace = join(root, "workspace"), context = join(root, "context"), descriptor = join(root, "descriptor.json");
  await mkdir(workspace); await mkdir(join(context, "parents", parent), { recursive: true });
  await writeFile(join(workspace, "source.txt"), "selected source\n");
  await writeFile(join(context, "parents", parent, "source.txt"), "selected source\n");
  await writeFile(join(context, "candidate.commit"), git("cat-file", "commit", commit) + "\n");
  await writeFile(join(context, `${parent}.commit`), git("cat-file", "commit", parent) + "\n");
  await writeFile(descriptor, JSON.stringify({ candidateCommit: commit, candidateTree: tree }));
  await writeFile(join(context, "context.json"), JSON.stringify({ schemaVersion: 1, mode: "candidate-and-immediate-parents",
    candidate: { commit, tree }, parents: [{ commit: parent, tree }] }));
  return { root, workspace, context, descriptor, parent, commit, tree };
}

it("reconstructs only the declared candidate and parent identities without automatic whole-store inspection", async () => {
  // Given exact selected files and raw commit bytes from a disposable real repository.
  const f = await fixture();
  try {
    vi.stubEnv("PATH", await gitWholeStoreFence(f.root));
    // When the normal source reconstruction runs with whole-store commands forbidden.
    const result = await reconstructPracticalSource(f.workspace, f.context, f.descriptor);
    // Then exact source/parent binding and the materialized checkout remain valid.
    expect(result).toEqual({ commit: f.commit, tree: f.tree, parents: [f.parent] });
    expect(await readFile(join(f.workspace, "source.txt"), "utf8")).toBe("selected source\n");
  } finally { vi.unstubAllEnvs(); await rm(f.root, { recursive: true, force: true }); }
});

it.each(["candidate-commit", "candidate-blob", "parent-commit", "parent-blob"] as const)("rejects changed selected source data without a whole-store scan: %s", async (part) => {
  const f = await fixture();
  try {
    vi.stubEnv("PATH", await gitWholeStoreFence(f.root));
    const selected = part === "candidate-commit" ? join(f.context, "candidate.commit")
      : part === "candidate-blob" ? join(f.workspace, "source.txt")
      : part === "parent-commit" ? join(f.context, `${f.parent}.commit`) : join(f.context, "parents", f.parent, "source.txt");
    await writeFile(selected, (await readFile(selected, "utf8")) + "changed\n");
    await expect(reconstructPracticalSource(f.workspace, f.context, f.descriptor)).rejects.toThrow(/mismatch/);
  } finally { vi.unstubAllEnvs(); await rm(f.root, { recursive: true, force: true }); }
});
