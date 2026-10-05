import type { NativeCandidateReadAuthority } from "./nativeOrdinaryCandidateVerifier.js";
import type { NativeCandidateReadAuthorityFactory } from "./nativeOrdinaryExecutor.js";
import {
  materializeVerifiedTree,
  readVerifiedBlob,
  readVerifiedCommit,
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
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
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
  readonly temporaryRoot: string;
  readonly claim: NativeGitCandidateClaim;
  readonly limits?: Partial<NativeGitReaderLimits>;
};

export type NativeGitCandidateReaderConfig = Omit<
  NativeGitCandidateReadOptions,
  "claim" | "temporaryRoot"
>;

export function createNativeGitCandidateReadAuthorityFactory(
  config: NativeGitCandidateReaderConfig
): NativeCandidateReadAuthorityFactory {
  return ({ claim, privateRoot, signal }) => {
    signal.throwIfAborted();
    const descriptor = claim.descriptor;
    return createNativeGitCandidateReadAuthority({
      ...config,
      temporaryRoot: privateRoot,
      claim: {
        projectId: descriptor.projectId,
        repositoryId: descriptor.repositoryId,
        protectedRef: descriptor.protectedRef,
        expectedProtectedHead: descriptor.expectedProtectedHead,
        candidateCommit: descriptor.candidateCommit,
        candidateTree: descriptor.candidateTree
      }
    });
  };
}

export function createNativeGitCandidateReadAuthority(
  options: NativeGitCandidateReadOptions
): NativeCandidateReadAuthority {
  const parsed = parseOptions(options);
  return {
    async resolveProtectedHead(input) {
      assertScope(parsed.claim, input);
      if (input.protectedRef !== parsed.claim.protectedRef) throw new NativeGitCandidateReadError("protected ref is outside the claim");
      return withGit(parsed, input.signal, (git) => resolveProtectedHead(git, parsed, input.signal));
    },
    async readCommit(input) {
      assertScope(parsed.claim, input);
      if (input.objectId !== parsed.claim.candidateCommit) throw new NativeGitCandidateReadError("commit is outside the claim");
      return withCandidate(parsed, input.signal, async (git) => {
        const commit = await readVerifiedCommit(git, input.objectId, input.signal);
        if (commit.treeObjectId !== parsed.claim.candidateTree) throw new NativeGitCandidateReadError("candidate commit tree does not match the claim");
        return commit;
      });
    },
    async readBlob(input) {
      assertScope(parsed.claim, input);
      if (input.treeObjectId !== parsed.claim.candidateTree) throw new NativeGitCandidateReadError("tree is outside the claim");
      return withCandidate(parsed, input.signal, (git) => readVerifiedBlob({
        git, treeObjectId: input.treeObjectId, path: input.path,
        maximumBytes: input.maximumBytes, limits: parsed.limits, signal: input.signal
      }));
    },
    async materializeTree(input) {
      assertScope(parsed.claim, input);
      if (input.commitObjectId !== parsed.claim.candidateCommit || input.treeObjectId !== parsed.claim.candidateTree) {
        throw new NativeGitCandidateReadError("materialization objects are outside the claim");
      }
      await assertProtectedHead(parsed, input.signal);
      await withCandidate(parsed, input.signal, async (git) => {
        const commit = await readVerifiedCommit(git, input.commitObjectId, input.signal);
        if (commit.treeObjectId !== input.treeObjectId) throw new NativeGitCandidateReadError("materialized commit tree does not match the claim");
        await materializeVerifiedTree({
          git, treeObjectId: input.treeObjectId, destination: input.destination,
          limits: parsed.limits, signal: input.signal
        });
      });
      await assertProtectedHead(parsed, input.signal);
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
  const protectedHeadFormat = objectIdFormat(options.claim.expectedProtectedHead);
  const candidateCommitFormat = objectIdFormat(options.claim.candidateCommit);
  const candidateTreeFormat = objectIdFormat(options.claim.candidateTree);
  if (!options.gitExecutable.startsWith("/") || !identifier(options.claim.projectId)
    || !identifier(options.claim.repositoryId) || !safeRef(options.claim.protectedRef)
    || protectedHeadFormat === undefined || candidateCommitFormat !== protectedHeadFormat
    || candidateTreeFormat !== protectedHeadFormat || !username(options.credential.username)
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
    objectFormat: protectedHeadFormat,
    limits
  };
}

async function withCandidate<T>(options: ParsedOptions, signal: AbortSignal, action: (git: DisposableGit) => Promise<T>): Promise<T> {
  return withGit(options, signal, async (git) => {
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
    return action(git);
  });
}

async function withGit<T>(options: ParsedOptions, signal: AbortSignal, action: (git: DisposableGit) => Promise<T>): Promise<T> {
  const git = await openDisposableGit({
    executable: options.gitExecutable,
    temporaryRoot: options.temporaryRoot,
    objectFormat: options.objectFormat,
    username: options.credential.username,
    password: options.credential.password,
    timeoutMilliseconds: options.limits.processTimeoutMilliseconds
  }, signal);
  try {
    return await action(git);
  } finally {
    await git.close();
  }
}

async function resolveProtectedHead(git: DisposableGit, options: ParsedOptions, signal: AbortSignal): Promise<string> {
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

async function assertProtectedHead(options: ParsedOptions, signal: AbortSignal): Promise<void> {
  const head = await withGit(options, signal, (git) => resolveProtectedHead(git, options, signal));
  if (head !== options.claim.expectedProtectedHead) throw new NativeGitCandidateReadError("protected head changed from the claim");
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
