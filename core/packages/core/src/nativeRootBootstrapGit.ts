import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { UserError } from "./errors.js";
import { compileNativeRootBootstrapPolicy, parseNativeRootBootstrapManifestYaml,
  type NativeRootBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";
import { normalizeRepositoryRef } from "./repositoryRef.js";

const execute = promisify(execFile);
const maximumBundleBytes = 256 * 1024 * 1024 - 64 * 1024 - 1;

export type NativeRootBootstrapGitInput = {
  readonly gitExecutable: string;
  readonly sourceRepository: string;
  readonly selectedRef: string;
  readonly scratchRoot: string;
  readonly policySource: { readonly kind: "reviewed-manifest" }
    | { readonly kind: "manifest-free"; readonly rootAlias: string; readonly review: unknown };
  readonly signal: AbortSignal;
};

export type NativeRootBootstrapGitPlan = NativeRootBootstrapPolicy & {
  readonly expectedCommit: string;
  readonly resolvedTree: string;
  readonly bundlePath: string;
  cleanup(): Promise<void>;
};

export async function prepareNativeRootBootstrapGit(
  input: NativeRootBootstrapGitInput
): Promise<NativeRootBootstrapGitPlan> {
  input.signal.throwIfAborted();
  if (!isAbsolute(input.gitExecutable) || !isAbsolute(input.sourceRepository)
    || !isAbsolute(input.scratchRoot) || !input.selectedRef.startsWith("refs/heads/")
    || input.selectedRef !== normalizeRepositoryRef(input.selectedRef)) {
    throw new UserError("native root bootstrap requires absolute local paths and a concrete branch ref");
  }
  const scratch = await lstat(input.scratchRoot);
  const source = await lstat(input.sourceRepository);
  const gitFile = await lstat(input.gitExecutable);
  if (!scratch.isDirectory() || scratch.isSymbolicLink() || (scratch.mode & 0o777) !== 0o700
    || scratch.uid !== process.geteuid?.() || !source.isDirectory() || source.isSymbolicLink()
    || !gitFile.isFile() || gitFile.isSymbolicLink()) {
    throw new UserError("native root bootstrap paths are not private local resources");
  }
  async function git(args: readonly string[], label: string): Promise<string> {
    input.signal.throwIfAborted();
    try {
      const result = await execute(input.gitExecutable, [...args], {
        maxBuffer: 128 * 1024, timeout: 30_000, signal: input.signal,
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/dev/null",
          LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }
      });
      input.signal.throwIfAborted();
      return result.stdout;
    } catch {
      throw new UserError(`native root bootstrap ${label} failed`);
    }
  }
  const sourceArgs = ["-C", input.sourceRepository];
  const format = (await git([...sourceArgs, "rev-parse", "--show-object-format"], "object format")).trim();
  if (format !== "sha1" && format !== "sha256") throw new UserError("native root object format is unsupported");
  const expectedCommit = (await git([...sourceArgs, "rev-parse", "--verify",
    `${input.selectedRef}^{commit}`], "protected commit lookup")).trim();
  if (expectedCommit.length !== (format === "sha1" ? 40 : 64)
    || !/^[0-9a-f]+$/.test(expectedCommit)) throw new UserError("native root commit is invalid");
  const resolvedTree = (await git([...sourceArgs, "rev-parse", "--verify",
    `${expectedCommit}^{tree}`], "protected tree lookup")).trim();
  if (resolvedTree.length !== expectedCommit.length || !/^[0-9a-f]+$/.test(resolvedTree)) {
    throw new UserError("native root tree is invalid");
  }
  let policy: NativeRootBootstrapPolicy;
  switch (input.policySource.kind) {
    case "reviewed-manifest": {
      const entry = await git([...sourceArgs, "ls-tree", expectedCommit, "--", ".dim/repos.yml"],
        "manifest object lookup");
      if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t\.dim\/repos\.yml\n$/.test(entry)) {
        throw new UserError("native root manifest must be a regular reviewed Git blob");
      }
      const yaml = await git([...sourceArgs, "show", `${expectedCommit}:.dim/repos.yml`], "manifest read");
      policy = parseNativeRootBootstrapManifestYaml(yaml, input.selectedRef);
      break;
    }
    case "manifest-free":
      policy = compileNativeRootBootstrapPolicy({ rootAlias: input.policySource.rootAlias,
        protectedRef: input.selectedRef, review: input.policySource.review });
      break;
    default: {
      const exhaustive: never = input.policySource;
      throw new UserError(`native root bootstrap policy source is unsupported: ${String(exhaustive)}`);
    }
  }
  const stage = await mkdtemp(join(input.scratchRoot, "dim-root-"));
  const repository = join(stage, "source.git");
  const verifier = join(stage, "verify.git");
  const bundlePath = join(stage, "root.bundle");
  try {
    await git(["init", "--bare", `--object-format=${format}`, repository], "private repository initialization");
    await git(["--git-dir", repository, "fetch", "--no-tags", "--no-write-fetch-head",
      input.sourceRepository, expectedCommit], "pinned commit transfer");
    await git(["--git-dir", repository, "update-ref", input.selectedRef, expectedCommit,
      "0".repeat(expectedCommit.length)], "private ref creation");
    await git(["--git-dir", repository, "bundle", "create", bundlePath, input.selectedRef], "bundle creation");
    await git(["init", "--bare", `--object-format=${format}`, verifier], "empty verifier initialization");
    await git(["--git-dir", verifier, "bundle", "verify", bundlePath], "bundle closure verification");
    const heads = await git(["bundle", "list-heads", bundlePath], "bundle ref verification");
    if (heads !== `${expectedCommit} ${input.selectedRef}\n`) {
      throw new UserError("native root bundle advertises an unexpected ref");
    }
    await chmod(bundlePath, 0o600);
    const bundle = await lstat(bundlePath);
    if (!bundle.isFile() || bundle.isSymbolicLink() || bundle.nlink !== 1
      || bundle.size < 1 || bundle.size > maximumBundleBytes || (bundle.mode & 0o777) !== 0o600) {
      throw new UserError("native root bundle is not a bounded private file");
    }
    await rm(repository, { recursive: true, force: true });
    await rm(verifier, { recursive: true, force: true });
    return { ...policy, expectedCommit, resolvedTree, bundlePath,
      cleanup: () => rm(stage, { recursive: true, force: true }) };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
