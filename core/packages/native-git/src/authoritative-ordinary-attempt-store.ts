import { randomUUID } from "node:crypto";
import {
  assertOrdinaryAttemptStoreLayout,
  initializeOrdinaryAttemptStore,
  maximumOrdinaryAttemptsPerJob,
  ordinaryAttemptStorePaths,
  pathExists,
  readOrdinaryAttempts,
  readOrdinaryAttemptsForJob,
  readCurrentOrdinaryAttempt,
  readOrdinaryRevocations,
  writeOrdinaryAttempt,
  writeOrdinaryRevocation
} from "./authoritative-ordinary-attempt-files.js";
import {
  authoritativeOrdinaryAttemptRevocationSchema,
  authoritativeOrdinaryAttemptSchema,
  type AuthoritativeOrdinaryAttempt,
  type AuthoritativeOrdinaryAttemptRevocation
} from "./authoritative-ordinary-attempt-schema.js";
import type { AuthoritativeOrdinaryExecutionDescriptor } from "./authoritative-ordinary-execution-descriptor.js";

type IssueInput = {
  readonly issuanceRequestId: string;
  readonly execution: AuthoritativeOrdinaryExecutionDescriptor;
  readonly hostId: string;
  readonly capacity: string;
  readonly issuedBy: string;
};
type RevokeInput = {
  readonly revocationRequestId: string;
  readonly reviewId: string;
  readonly jobName: string;
  readonly attemptId: string;
  readonly revokedBy: string;
};
export type CurrentAuthoritativeOrdinaryAttempt = {
  readonly attempt: AuthoritativeOrdinaryAttempt;
  readonly revocation: AuthoritativeOrdinaryAttemptRevocation | undefined;
};
export type AuthoritativeOrdinaryAttemptStore = {
  replay(input: IssueInput): Promise<AuthoritativeOrdinaryAttempt | undefined>;
  issue(input: IssueInput): Promise<AuthoritativeOrdinaryAttempt>;
  current(reviewId: string, jobName: string): Promise<CurrentAuthoritativeOrdinaryAttempt | undefined>;
  revoke(input: RevokeInput): Promise<AuthoritativeOrdinaryAttemptRevocation>;
};

export async function assertAuthoritativeOrdinaryAttemptStore(repository: string): Promise<void> {
  const paths = ordinaryAttemptStorePaths(repository);
  await assertOrdinaryAttemptStoreLayout(paths);
  if (!(await pathExists(paths.root))) return;
  const [attempts, revocations] = await Promise.all([readOrdinaryAttempts(paths), readOrdinaryRevocations(paths)]);
  if (new Set(attempts.map(({ issuanceRequestId }) => issuanceRequestId)).size !== attempts.length
    || new Set(attempts.map(({ attemptId }) => attemptId)).size !== attempts.length) {
    throw new AuthoritativeOrdinaryAttemptStoreError("ordinary attempt identity is duplicated");
  }
  if (new Set(revocations.map(({ revocationRequestId }) => revocationRequestId)).size !== revocations.length) {
    throw new AuthoritativeOrdinaryAttemptStoreError("ordinary revocation request identity is duplicated");
  }
  for (const revocation of revocations) {
    const attempt = attempts.find((candidate) => candidate.reviewId === revocation.reviewId
      && candidate.descriptor.jobName === revocation.jobName && candidate.attempt === revocation.attempt);
    if (attempt === undefined || !revocationMatches(revocation, attempt)) {
      throw new AuthoritativeOrdinaryAttemptStoreError("ordinary revocation does not match its attempt");
    }
  }
}

export function createAuthoritativeOrdinaryAttemptStore(repository: string): AuthoritativeOrdinaryAttemptStore {
  const paths = ordinaryAttemptStorePaths(repository);
  const current = async (reviewId: string, jobName: string): Promise<CurrentAuthoritativeOrdinaryAttempt | undefined> => {
    const selected = await readCurrentOrdinaryAttempt(paths, reviewId, jobName);
    if (selected === undefined) return undefined;
    if (selected.revocation !== undefined && !revocationMatches(selected.revocation, selected.attempt)) {
      throw new AuthoritativeOrdinaryAttemptStoreError("ordinary revocation is invalid");
    }
    return selected;
  };
  return {
    async replay(input) {
      if (!(await pathExists(paths.root))) return undefined;
      const prior = (await readOrdinaryAttemptsForJob(
        paths, input.execution.reviewId, input.execution.descriptor.jobName
      ))
        .find(({ issuanceRequestId }) => issuanceRequestId === input.issuanceRequestId);
      if (prior === undefined) return undefined;
      const state = await current(prior.reviewId, prior.descriptor.jobName);
      if (state?.revocation === undefined && state?.attempt.attemptId === prior.attemptId && issueMatches(prior, input)) {
        return prior;
      }
      throw new AuthoritativeOrdinaryAttemptStoreError("ordinary issuance request ID was already used");
    },
    async issue(input) {
      await initializeOrdinaryAttemptStore(paths);
      const jobName = input.execution.descriptor.jobName;
      const attempts = await readOrdinaryAttemptsForJob(paths, input.execution.reviewId, jobName);
      const prior = attempts.find(({ issuanceRequestId }) => issuanceRequestId === input.issuanceRequestId);
      const selected = attempts.at(-1);
      if (prior !== undefined) {
        const state = await current(prior.reviewId, prior.descriptor.jobName);
        if (state?.revocation === undefined && state?.attempt.attemptId === prior.attemptId && issueMatches(prior, input)) return prior;
        throw new AuthoritativeOrdinaryAttemptStoreError("ordinary issuance request ID was already used");
      }
      if ((selected?.attempt ?? 0) >= maximumOrdinaryAttemptsPerJob) {
        throw new AuthoritativeOrdinaryAttemptStoreError("ordinary attempt job reached its attempt bound");
      }
      const attempt = authoritativeOrdinaryAttemptSchema.parse({
        schemaVersion: 3, executionKind: "ordinary-sysbox", issuanceRequestId: input.issuanceRequestId,
        attemptId: randomUUID(), reviewId: input.execution.reviewId, attempt: (selected?.attempt ?? 0) + 1,
        descriptor: input.execution.descriptor, descriptorDigest: input.execution.digest,
        hostId: input.hostId, capacity: input.capacity, issuedBy: input.issuedBy, issuedAt: new Date().toISOString()
      });
      await writeOrdinaryAttempt(paths, attempt);
      return attempt;
    },
    current,
    async revoke(input) {
      await initializeOrdinaryAttemptStore(paths);
      const state = await current(input.reviewId, input.jobName);
      if (state === undefined || state.attempt.attemptId !== input.attemptId) {
        throw new AuthoritativeOrdinaryAttemptStoreError("current ordinary attempt was not found");
      }
      if (state.revocation !== undefined) {
        if (revocationInputMatches(state.revocation, input)) return state.revocation;
        throw new AuthoritativeOrdinaryAttemptStoreError("current ordinary attempt is already revoked");
      }
      const attempt = state.attempt;
      const revocation = authoritativeOrdinaryAttemptRevocationSchema.parse({
        schemaVersion: 3, executionKind: "ordinary-sysbox", revocationRequestId: input.revocationRequestId,
        revocationId: randomUUID(), attemptId: attempt.attemptId, reviewId: attempt.reviewId,
        jobName: attempt.descriptor.jobName, attempt: attempt.attempt, descriptorDigest: attempt.descriptorDigest,
        hostId: attempt.hostId, capacity: attempt.capacity, revokedBy: input.revokedBy, revokedAt: new Date().toISOString()
      });
      await writeOrdinaryRevocation(paths, revocation);
      return revocation;
    }
  };
}

function issueMatches(attempt: AuthoritativeOrdinaryAttempt, input: IssueInput): boolean {
  return attempt.reviewId === input.execution.reviewId && attempt.descriptorDigest === input.execution.digest
    && JSON.stringify(attempt.descriptor) === JSON.stringify(input.execution.descriptor)
    && attempt.hostId === input.hostId && attempt.capacity === input.capacity && attempt.issuedBy === input.issuedBy;
}
function revocationInputMatches(revocation: AuthoritativeOrdinaryAttemptRevocation, input: RevokeInput): boolean {
  return revocation.revocationRequestId === input.revocationRequestId
    && revocation.reviewId === input.reviewId && revocation.jobName === input.jobName
    && revocation.attemptId === input.attemptId && revocation.revokedBy === input.revokedBy;
}
function revocationMatches(revocation: AuthoritativeOrdinaryAttemptRevocation, attempt: AuthoritativeOrdinaryAttempt): boolean {
  return revocation.attemptId === attempt.attemptId && revocation.reviewId === attempt.reviewId
    && revocation.jobName === attempt.descriptor.jobName && revocation.attempt === attempt.attempt
    && revocation.descriptorDigest === attempt.descriptorDigest && revocation.hostId === attempt.hostId
    && revocation.capacity === attempt.capacity;
}

export class AuthoritativeOrdinaryAttemptStoreError extends Error {
  readonly name = "AuthoritativeOrdinaryAttemptStoreError";
}
