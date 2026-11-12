import { spawnSync } from "node:child_process";
import { lstat, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

/** Reconstruct exact local Git objects; no remote, credential, ref catalog or history walk. */
export async function reconstructPracticalSource(repository: string, context: string, descriptorFile: string): Promise<{ commit: string; tree: string; parents: string[] }> {
  const descriptor: unknown = JSON.parse(await readFile(descriptorFile, "utf8"));
  assert(descriptor && typeof descriptor === "object" && "candidateCommit" in descriptor && "candidateTree" in descriptor);
  const commit = descriptor.candidateCommit, tree = descriptor.candidateTree;
  assert(typeof commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit));
  assert(typeof tree === "string" && tree.length === commit.length && /^[a-f0-9]+$/.test(tree));
  repository = resolve(repository); context = resolve(context);
  await assert.rejects(lstat(join(repository, ".git")), { code: "ENOENT" });
  const metadata: unknown = JSON.parse(await readFile(join(context, "context.json"), "utf8"));
  assert(metadata && typeof metadata === "object" && "schemaVersion" in metadata && metadata.schemaVersion === 1
    && "mode" in metadata && metadata.mode === "candidate-and-immediate-parents" && "candidate" in metadata
    && "parents" in metadata && Array.isArray(metadata.parents));
  assert.deepEqual(metadata.candidate, { commit, tree });
  const raw = await readFile(join(context, "candidate.commit"));
  const parents = commitParents(raw, commit.length);
  assert(parents.length > 0, "practical upgrade requires an immediate-parent baseline");
  assert(parents.length <= 8 && new Set(parents).size === parents.length, "bounded distinct parents required");
  assert.equal(metadata.parents.length, parents.length);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const run = (args: string[], cwd = repository, additions: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...env, ...additions }, encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
    if (result.status !== 0) throw new Error(`exact source reconstruction failed: git ${args[0]}`);
    return result.stdout.trim();
  };
  run(["init", "--quiet", "--initial-branch=qualification", `--object-format=${commit.length === 40 ? "sha1" : "sha256"}`]);
  run(["add", "--force", "--all"]); assert.equal(run(["write-tree"]), tree, "materialized candidate tree mismatch");
  assert.equal(run(["hash-object", "-t", "commit", "-w", join(context, "candidate.commit")]), commit, "raw candidate commit mismatch");
  const temporary = await mkdtemp(join(tmpdir(), "dim-practical-index-"));
  try {
    for (const [index, parent] of parents.entries()) {
      const entry: unknown = metadata.parents[index];
      assert(entry && typeof entry === "object" && "commit" in entry && entry.commit === parent && "tree" in entry && typeof entry.tree === "string");
      const parentBytes = await readFile(join(context, `${parent}.commit`));
      assert.equal(parentBytes.subarray(0, parentBytes.indexOf(10)).toString("ascii"), `tree ${entry.tree}`);
      const parentDirectory = join(context, "parents", parent), gitDirectory = join(repository, ".git");
      const selected = { GIT_INDEX_FILE: join(temporary, `index-${index}`) };
      const git = ["--git-dir", gitDirectory, "--work-tree", parentDirectory];
      run([...git, "read-tree", "--empty"], parentDirectory, selected);
      run([...git, "add", "--force", "--all"], parentDirectory, selected);
      assert.equal(run([...git, "write-tree"], parentDirectory, selected), entry.tree, "materialized parent tree mismatch");
      assert.equal(run(["hash-object", "-t", "commit", "-w", join(context, `${parent}.commit`)]), parent, "raw parent commit mismatch");
    }
    await writeFile(join(repository, ".git/shallow"), parents.join("\n") + "\n", { mode: 0o600, flag: "wx" });
    run(["update-ref", "refs/heads/qualification", commit]);
    assert.equal(run(["rev-parse", "HEAD"]), commit); assert.equal(run(["rev-parse", "HEAD^{tree}"]), tree);
    assert.equal(run(["status", "--porcelain=v1", "--untracked-files=all"]), "", "exact source must be clean");
    assert.equal(run(["rev-parse", "HEAD^"]), parents[0]);
    return { commit, tree, parents };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function commitParents(bytes: Buffer, length: number): string[] {
  const end = bytes.indexOf(Buffer.from("\n\n")); assert(end >= 0, "raw commit header boundary missing");
  return bytes.subarray(0, end).toString("utf8").split("\n").filter(line => line.startsWith("parent ")).map(line => {
    const parent = new RegExp(`^parent ([a-f0-9]{${length}})$`).exec(line)?.[1]; assert(parent, "malformed raw parent"); return parent;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await reconstructPracticalSource(process.cwd(), "/run/dim/job/source-context", "/run/dim/job/descriptor.json");
  console.log(JSON.stringify({ schemaVersion: 1, status: "PASS", ...result }));
}
