import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAuthoritativeNativeReview,
  type AuthoritativeNativeReviewHooks
} from "./authoritative-native-review.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";
import { assertGitExecutableIdentity } from "./repository.js";

const execute = promisify(execFile);
const maximumProposalRefs = 10_000;
const maximumRefOutputBytes = 4 * 1024 * 1024;
const proposalRefPattern = /^refs\/heads\/proposals\/([A-Za-z0-9_-]{43})\/(.+)$/;

export type NativeProposalRefSnapshot = ReadonlyMap<string, string>;

export async function readNativeProposalRefs(
  runtime: Omit<AuthoritativeNativeCandidateRuntime, "workflowCompiler">,
  projectId: string,
  workspaceId?: string
): Promise<NativeProposalRefSnapshot> {
  const registration = readNativeProjectRegistrations(runtime.state)
    .find((candidate) => candidate.projectId === projectId);
  if (registration === undefined) throw new NativeProposalReconcilerError("native proposal Project is not registered");
  const repository = join(runtime.state.database, "..", projectId, `${registration.rootRepositoryId}.git`);
  const prefix = workspaceId === undefined
    ? "refs/heads/proposals/"
    : `refs/heads/proposals/${workspaceId}/`;
  await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
  const result = await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository,
    "for-each-ref", "--format=%(refname)%00%(objectname)", prefix], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C" },
    maxBuffer: maximumRefOutputBytes,
    timeout: 30_000
  });
  await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
  const refs = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("\0");
    const ref = separator < 0 ? "" : line.slice(0, separator);
    const objectId = separator < 0 ? "" : line.slice(separator + 1);
    if (!validProposalRef(ref) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
      throw new NativeProposalReconcilerError("native proposal ref enumeration is invalid");
    }
    refs.set(ref, objectId);
    if (refs.size > maximumProposalRefs) {
      throw new NativeProposalReconcilerError("native proposal ref capacity is exceeded");
    }
  }
  return refs;
}

export function changedNativeProposalRefs(
  before: NativeProposalRefSnapshot,
  after: NativeProposalRefSnapshot
): readonly string[] {
  return [...after].filter(([ref, objectId]) => before.get(ref) !== objectId)
    .map(([ref]) => ref).sort();
}

export async function reconcileNativeProposalRefs(
  runtime: AuthoritativeNativeCandidateRuntime,
  projectId: string,
  proposalRefs: readonly string[],
  hooks: AuthoritativeNativeReviewHooks = {}
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const proposalRef of proposalRefs) {
    envelopes.push(await createAuthoritativeNativeReview(runtime, {
      projectId, repositoryId: "root", proposalRef
    }, hooks));
  }
  return envelopes;
}

export async function reconcileRegisteredNativeProposals(
  runtime: AuthoritativeNativeCandidateRuntime,
  hooks: AuthoritativeNativeReviewHooks = {}
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const registration of readNativeProjectRegistrations(runtime.state)) {
    const refs = await readNativeProposalRefs(runtime, registration.projectId);
    envelopes.push(...await reconcileNativeProposalRefs(
      runtime, registration.projectId, [...refs.keys()].sort(), hooks
    ));
  }
  return envelopes;
}

function validProposalRef(ref: string): boolean {
  const match = proposalRefPattern.exec(ref);
  if (match === null) return false;
  const workspaceId = match[1];
  const proposal = match[2];
  return workspaceId !== undefined && Buffer.from(workspaceId, "base64url").length === 32
    && Buffer.from(workspaceId, "base64url").toString("base64url") === workspaceId
    && proposal !== undefined && proposal.length <= 1024 && !proposal.startsWith(".")
    && !proposal.includes("/.") && !proposal.includes("..") && !proposal.includes("//")
    && !proposal.endsWith("/") && !proposal.endsWith(".") && !proposal.endsWith(".lock")
    && /^[A-Za-z0-9._/-]+$/.test(proposal);
}

export class NativeProposalReconcilerError extends Error {
  readonly name = "NativeProposalReconcilerError";
}
