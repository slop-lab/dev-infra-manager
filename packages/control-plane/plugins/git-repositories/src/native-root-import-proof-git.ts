import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "./repository.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";

const execute = promisify(execFile);
const gitOptions = {
  env: {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/dev/null",
    LC_ALL: "C"
  },
  maxBuffer: 64 * 1024,
  timeout: 30_000
} as const;

type NativeRootProofGitInput = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly repository: string;
  readonly protectedRef: string;
  readonly extensionRefs?: readonly import("./extension-refs.js").RepositoryOwnedRef[];
  readonly authoritativeHeads?: readonly { readonly protectedRef: string; readonly commit: string }[];
  readonly importedCommit: string;
  readonly importedTree: string;
  readonly currentCommit: string;
  readonly currentTree: string;
  readonly signal: AbortSignal;
};

export async function inspectImportedNativeRootReadOnly(input: NativeRootProofGitInput): Promise<void> {
  try {
    const format = (await runPinned(input, ["rev-parse", "--show-object-format"])).stdout.trim();
    if (format !== "sha1" && format !== "sha256") {
      throw new NativeRootImportBundleError("native root object format is unsupported");
    }
    const objectIdLength = format === "sha1" ? 40 : 64;
    if ([input.importedCommit, input.importedTree, input.currentCommit, input.currentTree]
      .some((objectId) => objectId.length !== objectIdLength)) {
      throw new NativeRootImportBundleError("native root object format conflicts with imported root proof");
    }
    await inspectRefs(input);
    const objectType = (await runPinned(input, ["cat-file", "-t", input.currentCommit])).stdout;
    if (objectType !== "commit\n") {
      throw new NativeRootImportBundleError("native root proof target is not a commit");
    }
    const tree = (await runPinned(input, ["rev-parse", "--verify", `${input.currentCommit}^{tree}`])).stdout.trim();
    if (tree !== input.currentTree) {
      throw new NativeRootImportBundleError("native root current tree conflicts");
    }
    await runPinned(input, ["merge-base", "--is-ancestor", input.importedCommit, input.currentCommit]);
    const importedTree = (await runPinned(input,
      ["rev-parse", "--verify", `${input.importedCommit}^{tree}`])).stdout.trim();
    if (importedTree !== input.importedTree) {
      throw new NativeRootImportBundleError("native root imported tree conflicts");
    }
    await runPinned(input, ["-c", "fsck.fullPathname=error", "fsck", "--strict", "--full",
      "--no-reflogs", "--no-progress", input.currentCommit]);
    await inspectRefs(input);
  } catch (error) {
    if (error instanceof NativeRootImportBundleError) throw error;
    throw new NativeRootImportBundleError("native imported root proof inspection failed", { cause: error });
  }
}

export async function assertNativeRootSelectionFastForward(
  input: NativeRootProofGitInput,
  selectedCommit: string,
  selectedTree: string
): Promise<void> {
  try {
    const tree = (await runPinned(input,
      ["rev-parse", "--verify", `${selectedCommit}^{tree}`])).stdout.trim();
    if (tree !== selectedTree) {
      throw new NativeRootImportBundleError("native root selected tree conflicts");
    }
    await runPinned(input, ["merge-base", "--is-ancestor", selectedCommit, input.currentCommit]);
  } catch (error) {
    if (error instanceof NativeRootImportBundleError) throw error;
    throw new NativeRootImportBundleError("native root selection is not a fast-forward", { cause: error });
  }
}

async function inspectRefs(input: NativeRootProofGitInput): Promise<void> {
  const records = (await runPinned(input, ["for-each-ref", "--format=%(refname) %(objectname)"], 8 * 1024 * 1024))
    .stdout.split("\n").filter((record) => record.length > 0);
  const refs = new Map(records.map((record) => { const split = record.indexOf(" "); return [record.slice(0, split), record.slice(split + 1)] as const; }));
  const heads = input.authoritativeHeads ?? [{ protectedRef: input.protectedRef, commit: input.currentCommit }];
  const protectedRefs = new Map(heads.map((head) => [head.protectedRef, head.commit]));
  const ownedRefs = new Map((input.extensionRefs ?? []).map((owned) => [owned.ref, owned.commit]));
  if (protectedRefs.get(input.protectedRef) !== input.currentCommit || heads.some((head) => !refs.has(head.protectedRef)) || [...refs.keys()].some((ref) =>
    !protectedRefs.has(ref) && !isWorkspaceProposalRef(ref) && !isUpstreamTrackingRef(ref) && !ownedRefs.has(ref))) {
    throw new NativeRootImportBundleError("native root repository contains a foreign ref");
  }
  // One bounded snapshot validates every exact pin. Missing declared pins can
  // be repaired after interruption; existing pins must match their owner.
  for (const [ref, expected] of ownedRefs) {
    if (refs.has(ref) && refs.get(ref) !== expected) throw new NativeRootImportBundleError("repository extension ref conflicts with its durable owner");
  }
  for (const head of heads) {
    if (refs.get(head.protectedRef) !== head.commit) throw new NativeRootImportBundleError("native root protected ref conflicts");
  }
}

/** Upstream synchronization caches source heads only; workspace receive hooks cannot write this namespace. */
function isUpstreamTrackingRef(ref: string): boolean {
  const suffix = ref.startsWith("refs/remotes/upstream/") ? ref.slice("refs/remotes/upstream/".length) : "";
  return suffix.length > 0 && suffix.length <= 512 && !/[\x00-\x20\x7f~^:?*[\\\]]/.test(suffix)
    && suffix.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))
    && !suffix.includes("..") && !suffix.includes("@{");
}

function isWorkspaceProposalRef(ref: string): boolean {
  const proposal = /^refs\/heads\/proposals\/[A-Za-z0-9_-]{43}\/([A-Za-z0-9._/-]+)$/.exec(ref)?.[1];
  return proposal !== undefined && !proposal.startsWith(".") && !proposal.includes("/.")
    && !proposal.includes("..") && !proposal.includes("//") && !proposal.endsWith("/")
    && !proposal.endsWith(".") && !proposal.endsWith(".lock");
}

async function runPinned(
  input: Pick<NativeRootProofGitInput, "gitExecutable" | "gitIdentity" | "repository" | "signal">,
  arguments_: readonly string[],
  maxBuffer: number = gitOptions.maxBuffer
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const result = await execute(input.gitExecutable,
    ["--no-replace-objects", "--git-dir", input.repository, ...arguments_],
    { ...gitOptions, maxBuffer, signal: input.signal });
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  return result;
}
