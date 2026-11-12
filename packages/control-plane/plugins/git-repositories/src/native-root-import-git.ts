import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "./repository.js";
import { syncNativeRootObjectStore, syncNativeRootProtectedRef } from "./native-root-import-durability.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";

const execute = promisify(execFile);
const gitOptions = {
  env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
  maxBuffer: 64 * 1024,
  timeout: 30_000
} as const;

type PinnedGit = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly signal: AbortSignal;
};

export async function assertNativeRootObjectFormat(
  input: PinnedGit & { readonly repository: string; readonly expectedCommit: string }
): Promise<"sha1" | "sha256"> {
  const result = await runPinned(input, ["--git-dir", input.repository, "rev-parse", "--show-object-format"]);
  const format = result.stdout.trim();
  if (format !== "sha1" && format !== "sha256") {
    throw new NativeRootImportBundleError("native root object format is unsupported");
  }
  if (input.expectedCommit.length !== (format === "sha1" ? 40 : 64)) {
    throw new NativeRootImportBundleError("native root object format does not match expected commit");
  }
  return format;
}

export async function verifyNativeRootBundle(input: PinnedGit & {
  readonly directory: string;
  readonly canonicalRepository: string;
  readonly bundlePath: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
}): Promise<void> {
  const format = await assertNativeRootObjectFormat({
    ...input, repository: input.canonicalRepository
  });
  const repository = join(input.directory, `.verify-${randomUUID()}`);
  await mkdir(repository, { mode: 0o700 });
  try {
    await chmod(repository, 0o700);
    await runPinned(input, ["init", "--bare", `--object-format=${format}`, repository]);
    await runPinned(input, ["--git-dir", repository, "bundle", "verify", input.bundlePath]);
    const heads = await runPinned(input, ["bundle", "list-heads", input.bundlePath]);
    if (heads.stdout !== `${input.expectedCommit} ${input.protectedRef}\n`) {
      throw new NativeRootImportBundleError("root bundle must advertise exactly the requested ref and commit");
    }
    await fetchNativeRootBundle({ ...input, repository });
    await assertNativeRootObjectIdentity({ ...input, repository }, input.expectedCommit, "commit");
    const tree = await resolveNativeRootTree({ ...input, repository });
    await assertNativeRootObjectIdentity({ ...input, repository }, tree, "tree");
  } catch (error) {
    if (error instanceof NativeRootImportBundleError) throw error;
    throw new NativeRootImportBundleError("root bundle verification failed", { cause: error });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

export async function installNativeRootObjects(input: PinnedGit & {
  readonly repository: string;
  readonly bundlePath: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
}): Promise<string> {
  await assertNativeRootRefUnborn(input);
  try {
    await fetchNativeRootBundle(input);
    await assertNativeRootObjectIdentity(input, input.expectedCommit, "commit");
    const tree = await resolveNativeRootTree(input);
    await assertNativeRootObjectIdentity(input, tree, "tree");
    await syncNativeRootObjectStore(input.repository);
    await assertNativeRootRefUnborn(input);
    return tree;
  } catch (error) {
    if (error instanceof NativeRootImportBundleError) throw error;
    throw new NativeRootImportBundleError("native root object installation failed", { cause: error });
  }
}

async function fetchNativeRootBundle(input: PinnedGit & {
  readonly repository: string;
  readonly bundlePath: string;
  readonly protectedRef: string;
}): Promise<void> {
  await runPinned(input, ["--git-dir", input.repository,
    "-c", "core.fsyncMethod=fsync", "-c", "core.fsync=all",
    "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true",
    "-c", "fsck.fullPathname=error", "-c", "fetch.unpackLimit=1",
    "fetch", "--no-write-fetch-head", "--no-tags", input.bundlePath, input.protectedRef]);
}

export async function publishNativeRootRef(input: PinnedGit & {
  readonly repository: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
}): Promise<void> {
  const current = await readRef(input);
  if (current !== input.expectedCommit) {
    if (current !== undefined) throw new NativeRootImportBundleError("native root protected ref conflicts");
    await assertNativeRootRefUnborn(input);
    try {
      await runPinned(input, ["--git-dir", input.repository, "-c", "core.fsyncMethod=fsync",
        "-c", "core.fsync=all", "update-ref", input.protectedRef,
        input.expectedCommit, "0".repeat(input.expectedCommit.length)]);
    } catch (error) {
      throw new NativeRootImportBundleError("native root protected ref compare-and-swap failed", { cause: error });
    }
  }
  await syncNativeRootProtectedRef(input.repository, input.protectedRef);
  if (await readRef(input) !== input.expectedCommit) {
    throw new NativeRootImportBundleError("native root protected ref conflicts");
  }
  await assertOnlyProtectedRef(input, true);
}

export async function assertImportedNativeRoot(input: PinnedGit & {
  readonly repository: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly resolvedTree: string;
}): Promise<void> {
  await assertOnlyProtectedRef(input, true);
  if (await readRef(input) !== input.expectedCommit) {
    throw new NativeRootImportBundleError("native root protected ref conflicts");
  }
  await assertInstalledNativeRootObjects(input);
  await syncNativeRootProtectedRef(input.repository, input.protectedRef);
}

export async function assertInstalledNativeRootObjects(input: PinnedGit & {
  readonly repository: string;
  readonly expectedCommit: string;
  readonly resolvedTree: string;
}): Promise<void> {
  await assertNativeRootObjectIdentity(input, input.expectedCommit, "commit");
  const tree = await resolveNativeRootTree(input);
  if (tree !== input.resolvedTree) throw new NativeRootImportBundleError("native root resolved tree conflicts");
  await assertNativeRootObjectIdentity(input, tree, "tree");
  await syncNativeRootObjectStore(input.repository);
}

async function assertNativeRootObjectIdentity(
  input: PinnedGit & { readonly repository: string },
  objectId: string,
  type: "commit" | "tree"
): Promise<void> {
  const algorithm = objectId.length === 40 ? "sha1" : objectId.length === 64 ? "sha256" : undefined;
  if (algorithm === undefined) throw new NativeRootImportBundleError("native root object identity is invalid");
  const content = await runPinnedBytes(input, ["--git-dir", input.repository, "cat-file", type, objectId]);
  const actual = createHash(algorithm)
    .update(`${type} ${String(content.length)}\0`)
    .update(content)
    .digest("hex");
  if (actual !== objectId) throw new NativeRootImportBundleError(`native root selected ${type} identity is invalid`);
}

async function resolveNativeRootTree(
  input: PinnedGit & { readonly repository: string; readonly expectedCommit: string }
): Promise<string> {
  const tree = (await runPinned(input, ["--git-dir", input.repository, "rev-parse", "--verify",
    `${input.expectedCommit}^{tree}`])).stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) || tree.length !== input.expectedCommit.length) {
    throw new NativeRootImportBundleError("native root resolved tree is invalid");
  }
  return tree;
}

export async function assertNativeRootRefUnborn(input: PinnedGit & {
  readonly repository: string;
  readonly protectedRef: string;
}): Promise<void> {
  if (await readRef(input) !== undefined) {
    throw new NativeRootImportBundleError("native root protected ref conflicts");
  }
  await assertOnlyProtectedRef(input, false);
}

async function assertOnlyProtectedRef(
  input: PinnedGit & { readonly repository: string; readonly protectedRef: string },
  expected: boolean
): Promise<void> {
  const refs = (await runPinned(input, ["--git-dir", input.repository, "for-each-ref", "--format=%(refname)"]))
    .stdout.split("\n").filter((ref) => ref.length > 0);
  const expectedRefs = expected ? [input.protectedRef] : [];
  if (refs.length !== expectedRefs.length || refs.some((ref, index) => ref !== expectedRefs[index])) {
    throw new NativeRootImportBundleError("native root repository contains a foreign ref");
  }
}

async function readRef(
  input: PinnedGit & { readonly repository: string; readonly protectedRef: string }
): Promise<string | undefined> {
  try {
    return (await runPinned(input, ["--git-dir", input.repository, "show-ref", "--verify", "--hash", input.protectedRef]))
      .stdout.trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === 1 || error.code === 128)) {
      if (!await pathExists(join(input.repository, input.protectedRef))
        && !await pathExists(join(input.repository, "packed-refs"))) return undefined;
    }
    throw new NativeRootImportBundleError("native root protected ref inspection failed", { cause: error });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new NativeRootImportBundleError("native root protected ref path is invalid", { cause: error });
  }
}

async function runPinned(input: PinnedGit, arguments_: readonly string[]): Promise<{
  readonly stdout: string; readonly stderr: string;
}> {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const result = await execute(input.gitExecutable, arguments_, { ...gitOptions, signal: input.signal });
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  return result;
}

async function runPinnedBytes(input: PinnedGit, arguments_: readonly string[]): Promise<Buffer> {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const result = await execute(input.gitExecutable, arguments_, {
    ...gitOptions,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
    signal: input.signal
  });
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  return result.stdout;
}
