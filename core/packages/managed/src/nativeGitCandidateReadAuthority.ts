import type { ExecutionDescriptor } from "@slop-lab/dim-native-git/execution";
import type { NativeCandidateReadAuthority } from "./ci/candidate.js";
import {
  materializeVerifiedTree,
  readVerifiedBlob,
  readVerifiedCommit,
  type CandidateMaterializationBudget,
  type CandidateObjectLimits
} from "./nativeGitCandidateObjects.js";
import {
  openDisposableGit,
  type DisposableGit,
  type GitObjectFormat
} from "./nativeGitCandidateProcess.js";

export type NativeGitCandidateClaim = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef?: string;
  readonly expectedProtectedHead?: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
};

export type NativeGitReaderLimits = {
  readonly processTimeoutMilliseconds: number;
  readonly maximumBlobBytes: number;
  readonly maximumMaterializedBytes: number;
  readonly maximumTreeBytes: number;
  readonly maximumEntries: number;
  readonly maximumDepth: number;
};

export type NativeGitCandidateReadOptions = {
  readonly gitExecutable: string;
  readonly serviceEndpoint: string;
  readonly credential: {
    readonly username: string;
    readonly password: string;
  };
  readonly credentialProvider?: (signal: AbortSignal) => Promise<{ readonly username: string; readonly password: string }>;
  readonly temporaryRoot: string;
  readonly claim: NativeGitCandidateClaim;
  readonly limits?: Partial<NativeGitReaderLimits>;
};

export type NativeGitCandidateReadSession = NativeCandidateReadAuthority & { close(): Promise<void> };

export function openNativeGitCandidateReadAuthority(
  options: NativeGitCandidateReadOptions,
  budget: CandidateMaterializationBudget = { entries: 0, bytes: 0, treeBytes: 0 }
): NativeGitCandidateReadSession {
  const parsed = parseOptions(options);
  let closed = false;
  let opened: Promise<DisposableGit> | undefined;
  let fetched: Promise<Awaited<ReturnType<typeof readVerifiedCommit>>> | undefined;
  async function git(signal: AbortSignal) {
    if (closed) throw new NativeGitCandidateReadError("candidate reader session is closed");
    signal.throwIfAborted();
    opened ??= openDisposableGit({ executable: parsed.gitExecutable, temporaryRoot: parsed.temporaryRoot,
      objectFormat: parsed.objectFormat, username: parsed.credential.username, password: parsed.credential.password,
      ...(parsed.credentialProvider === undefined ? {} : { credentialProvider: parsed.credentialProvider }),
      timeoutMilliseconds: parsed.limits.processTimeoutMilliseconds }, signal);
    return opened;
  }
  async function candidate(signal: AbortSignal) {
    const session = await git(signal);
    fetched ??= (async () => {
      await fetchCandidate(session, parsed, signal);
      const commit = await readVerifiedCommit(session, parsed.claim.candidateCommit, signal);
      if (commit.treeObjectId !== parsed.claim.candidateTree) throw new NativeGitCandidateReadError("candidate commit tree does not match the claim");
      return commit;
    })();
    const commit = await fetched;
    return { git: session, commit };
  }
  async function current(signal: AbortSignal) {
    if (parsed.claim.protectedRef === undefined) return;
    const head = await resolveProtectedHead(await git(signal), parsed, signal);
    if (head !== parsed.claim.expectedProtectedHead) throw new NativeGitCandidateReadError("protected head changed from the claim");
  }
  return {
    async close() {
      if (closed) return; closed = true;
      if (opened !== undefined) {
        let session: DisposableGit;
        try { session = await opened; } catch { return; }
        await session.close();
      }
    },
    async resolveProtectedHead(input) {
      assertScope(parsed.claim, input);
      if (input.protectedRef !== parsed.claim.protectedRef) throw new NativeGitCandidateReadError("protected ref is outside the claim");
      if (parsed.claim.protectedRef === undefined) throw new NativeGitCandidateReadError("snapshot has no protected ref");
      return resolveProtectedHead(await git(input.signal), parsed, input.signal);
    },
    async readCommit(input) {
      assertScope(parsed.claim, input);
      if (input.objectId !== parsed.claim.candidateCommit) throw new NativeGitCandidateReadError("commit is outside the claim");
      return (await candidate(input.signal)).commit;
    },
    async readBlob(input) {
      assertScope(parsed.claim, input);
      if (input.treeObjectId !== parsed.claim.candidateTree) throw new NativeGitCandidateReadError("tree is outside the claim");
      return readVerifiedBlob({
        git: (await candidate(input.signal)).git, treeObjectId: input.treeObjectId, path: input.path,
        maximumBytes: input.maximumBytes, limits: parsed.limits, signal: input.signal
      });
    },
    async materializeTree(input) {
      assertScope(parsed.claim, input);
      if (input.commitObjectId !== parsed.claim.candidateCommit || input.treeObjectId !== parsed.claim.candidateTree) {
        throw new NativeGitCandidateReadError("materialization objects are outside the claim");
      }
      await current(input.signal);
      const selected = await candidate(input.signal);
      await materializeVerifiedTree({ git: selected.git, treeObjectId: input.treeObjectId, destination: input.destination,
        limits: parsed.limits, budget, signal: input.signal });
      await current(input.signal);
      return { commitObjectId: input.commitObjectId, treeObjectId: input.treeObjectId };
    }
  };
}

type ParsedOptions = Omit<NativeGitCandidateReadOptions, "limits" | "serviceEndpoint"> & {
  readonly serviceEndpoint: string;
  readonly repositoryUrl: string;
  readonly objectFormat: GitObjectFormat;
  readonly limits: NativeGitReaderLimits;
};

const defaultLimits = {
  processTimeoutMilliseconds: 30_000,
  maximumBlobBytes: 256 * 1024 * 1024,
  maximumMaterializedBytes: 256 * 1024 * 1024,
  maximumTreeBytes: 16 * 1024 * 1024,
  maximumEntries: 100_000,
  maximumDepth: 64
} as const satisfies NativeGitReaderLimits;

function parseOptions(options: NativeGitCandidateReadOptions): ParsedOptions {
  const protectedHeadFormat = options.claim.expectedProtectedHead === undefined ? undefined : objectIdFormat(options.claim.expectedProtectedHead);
  const candidateCommitFormat = objectIdFormat(options.claim.candidateCommit);
  const candidateTreeFormat = objectIdFormat(options.claim.candidateTree);
  if (!options.gitExecutable.startsWith("/") || !identifier(options.claim.projectId)
    || !identifier(options.claim.repositoryId)
    || (options.claim.protectedRef === undefined) !== (options.claim.expectedProtectedHead === undefined)
    || options.claim.protectedRef !== undefined && (!safeRef(options.claim.protectedRef) || protectedHeadFormat === undefined || candidateCommitFormat !== protectedHeadFormat)
    || candidateCommitFormat === undefined
    || candidateTreeFormat !== candidateCommitFormat || !username(options.credential.username)
    || !password(options.credential.password)) {
    throw new NativeGitCandidateReadError("native Git candidate reader options are invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(options.serviceEndpoint);
  } catch (error) {
    if (error instanceof TypeError) throw new NativeGitCandidateReadError("native Git endpoint is invalid", { cause: error });
    throw error;
  }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username !== ""
    || endpoint.password !== "" || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new NativeGitCandidateReadError("native Git endpoint must be an HTTP origin without credentials");
  }
  const limits = { ...defaultLimits, ...options.limits };
  if (!boundedPositiveInteger(limits.processTimeoutMilliseconds, defaultLimits.processTimeoutMilliseconds)
    || !boundedPositiveInteger(limits.maximumBlobBytes, defaultLimits.maximumBlobBytes)
    || !boundedPositiveInteger(limits.maximumMaterializedBytes, defaultLimits.maximumMaterializedBytes)
    || !boundedPositiveInteger(limits.maximumTreeBytes, defaultLimits.maximumTreeBytes)
    || !boundedPositiveInteger(limits.maximumEntries, defaultLimits.maximumEntries)
    || !boundedPositiveInteger(limits.maximumDepth, defaultLimits.maximumDepth)) {
    throw new NativeGitCandidateReadError("native Git candidate reader limits are invalid");
  }
  const serviceEndpoint = endpoint.origin;
  return {
    ...options,
    serviceEndpoint,
    repositoryUrl: `${serviceEndpoint}/v1/projects/${options.claim.projectId}/repositories/${options.claim.repositoryId}.git`,
    objectFormat: candidateCommitFormat,
    limits
  };
}

async function fetchCandidate(git: DisposableGit, options: ParsedOptions, signal: AbortSignal): Promise<void> {
    await git.runAuthenticated([
      "--git-dir", git.repository, "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--force",
      options.repositoryUrl, `${options.claim.candidateCommit}:refs/dim/candidate`
    ], 64 * 1024, signal);
    await git.run([
      "--git-dir", git.repository, "fsck", "--strict", "--full", "--no-reflogs", "--no-progress"
    ], 64 * 1024, signal);
    const fetched = (await git.run([
      "--git-dir", git.repository, "rev-parse", "--verify", "refs/dim/candidate^{commit}"
    ], 128, signal)).toString("ascii").trim();
    if (fetched !== options.claim.candidateCommit) throw new NativeGitCandidateReadError("native Git returned a different candidate commit");
}

async function resolveProtectedHead(git: DisposableGit, options: ParsedOptions, signal: AbortSignal): Promise<string> {
  if (options.claim.protectedRef === undefined) throw new NativeGitCandidateReadError("snapshot has no protected ref");
  const output = (await git.runAuthenticated([
    "ls-remote", "--refs", options.repositoryUrl, options.claim.protectedRef
  ], 4096, signal)).toString("ascii");
  const objectIdLength = options.objectFormat === "sha1" ? 40 : 64;
  const match = new RegExp(`^([0-9a-f]{${objectIdLength}})\\t([^\\n]+)\\n$`).exec(output);
  if (match?.[1] === undefined || match[2] !== options.claim.protectedRef) {
    throw new NativeGitCandidateReadError("native Git protected ref response is invalid");
  }
  return match[1];
}

function assertScope(claim: NativeGitCandidateClaim, input: { readonly projectId: string; readonly repositoryId: string }): void {
  if (input.projectId !== claim.projectId || input.repositoryId !== claim.repositoryId) {
    throw new NativeGitCandidateReadError("repository is outside the claim");
  }
}

function identifier(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function objectIdFormat(value: string): GitObjectFormat | undefined {
  if (/^[0-9a-f]{40}$/.test(value)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(value)) return "sha256";
  return undefined;
}

function username(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value);
}

function password(value: string): boolean {
  return value.length >= 16 && value.length <= 1024 && !/[\0\r\n]/.test(value);
}

function safeRef(value: string): boolean {
  const branch = value.slice("refs/heads/".length);
  return value.startsWith("refs/heads/") && !value.startsWith("refs/heads/proposals/")
    && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock")
    && !value.includes("..") && !value.includes("@{") && !value.includes("\\")
    && !/[\x00-\x20\x7f~^:?*[\]]/.test(value)
    && branch.split("/").every((component) => component.length > 0 && !component.startsWith("."));
}

function boundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

export class NativeGitCandidateReadError extends Error {
  readonly name = "NativeGitCandidateReadError";
}

/** Objects and credentials exist only during trusted acquisition, before any job starts. */
export async function withNativeGitExecutionReadAuthority<T>(options: Omit<NativeGitCandidateReadOptions, "claim"> & {
  readonly descriptor: ExecutionDescriptor;
}, signal: AbortSignal, action: (authority: NativeCandidateReadAuthority) => Promise<T>): Promise<T> {
  const descriptor = options.descriptor;
  const budget: CandidateMaterializationBudget = { entries: 0, bytes: 0, treeBytes: 0 };
  const readers = new Map(Object.entries(descriptor.inputs).map(([repositoryId, snapshot]) => [repositoryId,
    openNativeGitCandidateReadAuthority({ ...options, claim: { projectId: descriptor.projectId, repositoryId,
      candidateCommit: snapshot.commit, candidateTree: snapshot.tree,
      ...(repositoryId !== descriptor.repositoryId ? {} : { protectedRef: descriptor.protectedRef, expectedProtectedHead: descriptor.expectedProtectedHead }) } }, budget)]));
  function select(input: { projectId: string; repositoryId: string }) {
    const reader = readers.get(input.repositoryId);
    if (input.projectId !== descriptor.projectId || reader === undefined) throw new NativeGitCandidateReadError("repository is outside execution inputs");
    return reader;
  }
  const authority: NativeCandidateReadAuthority = { resolveProtectedHead: (input) => select(input).resolveProtectedHead(input),
    readCommit: (input) => select(input).readCommit(input), readBlob: (input) => select(input).readBlob(input),
    materializeTree: (input) => select(input).materializeTree(input) };
  try {
    const result = await action(authority);
    // The remote probe authenticates the live execution lease again, including
    // dependency heads and current-attempt authority, even when objects are cached.
    const head = await authority.resolveProtectedHead({ projectId: descriptor.projectId, repositoryId: descriptor.repositoryId,
      protectedRef: descriptor.protectedRef, signal });
    if (head !== descriptor.expectedProtectedHead) throw new NativeGitCandidateReadError("protected head changed before candidate handoff");
    return result;
  } finally {
    const cleanup = await Promise.allSettled([...readers.values()].map((reader) => reader.close()));
    const failures = cleanup.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), "candidate reader cleanup failed");
  }
}
