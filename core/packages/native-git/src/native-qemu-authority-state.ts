import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { publishNativeQemuAuthorityState, readNativeQemuAuthorityStateFile,
  type NativeQemuAuthorityPublicationFaults } from "./native-qemu-authority-files.js";
import { qemuExecutionDescriptorDigest, qemuExecutionDescriptorSchema } from "./qemu-execution-descriptor.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const attemptSchema = z.object({
  schemaVersion: z.literal(1), executionKind: z.literal("qemu"), issuanceRequestId: z.string().uuid(),
  attemptId: z.string().uuid(), reviewId: z.string().regex(/^[0-9a-f]{64}$/), attempt: z.number().int().positive(),
  descriptor: qemuExecutionDescriptorSchema, descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  hostId: identifier, capacity: identifier, issuedAt: z.string().datetime(), revokedAt: z.string().datetime().optional()
}).strict().readonly().superRefine((attempt, context) => {
  if (qemuExecutionDescriptorDigest(attempt.descriptor) !== attempt.descriptorDigest) {
    context.addIssue({ code: "custom", path: ["descriptorDigest"], message: "invalid QEMU descriptor digest" });
  }
});
const statusSchema = z.object({
  schemaVersion: z.literal(1), executionKind: z.literal("qemu"), eventId: z.string().uuid(),
  attemptId: z.string().uuid(), descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  result: z.enum(["success", "failure", "cancelled"]), event: z.record(z.string(), z.unknown())
}).strict().readonly();
const stateSchema = z.object({ schemaVersion: z.literal(1), attempts: z.array(attemptSchema).readonly(),
  statuses: z.array(statusSchema).readonly() }).strict().readonly().superRefine((state, context) => {
  const attemptIds = new Set<string>();
  const issuanceRequestIds = new Set<string>();
  const jobs = new Map<string, NativeQemuAttemptRecord[]>();
  for (const attempt of state.attempts) {
    if (attemptIds.has(attempt.attemptId) || issuanceRequestIds.has(attempt.issuanceRequestId)) {
      context.addIssue({ code: "custom", message: "duplicate QEMU attempt identity" });
    }
    attemptIds.add(attempt.attemptId);
    issuanceRequestIds.add(attempt.issuanceRequestId);
    const key = `${attempt.reviewId}\0${attempt.descriptor.jobName}`;
    jobs.set(key, [...(jobs.get(key) ?? []), attempt]);
  }
  for (const attempts of jobs.values()) {
    if (attempts.some((attempt, index) => attempt.attempt !== index + 1)
      || attempts.filter(({ revokedAt }) => revokedAt === undefined).length > 1) {
      context.addIssue({ code: "custom", message: "invalid QEMU attempt sequence" });
    }
  }
  const statusAttempts = new Set<string>();
  const statusEvents = new Set<string>();
  for (const status of state.statuses) {
    const attempt = state.attempts.find(({ attemptId }) => attemptId === status.attemptId);
    if (attempt === undefined || attempt.descriptorDigest !== status.descriptorDigest
      || statusAttempts.has(status.attemptId) || statusEvents.has(status.eventId)) {
      context.addIssue({ code: "custom", message: "invalid QEMU status identity" });
    }
    statusAttempts.add(status.attemptId);
    statusEvents.add(status.eventId);
  }
});

export type NativeQemuAttemptRecord = z.infer<typeof attemptSchema>;
export type NativeQemuStatusRecord = z.infer<typeof statusSchema>;
type State = z.infer<typeof stateSchema>;
export type { NativeQemuAuthorityPublicationFaults } from "./native-qemu-authority-files.js";

export class NativeQemuAuthorityState {
  readonly #repository: string;
  readonly #faults: NativeQemuAuthorityPublicationFaults;
  constructor(repository: string, faults: NativeQemuAuthorityPublicationFaults = {}) {
    this.#repository = repository;
    this.#faults = faults;
  }
  async issue(input: { readonly issuanceRequestId: string; readonly reviewId: string;
    readonly descriptor: z.infer<typeof qemuExecutionDescriptorSchema>; readonly descriptorDigest: string;
    readonly hostId: string; readonly capacity: string }): Promise<NativeQemuAttemptRecord> {
    const state = await this.load();
    const replay = state.attempts.find(({ issuanceRequestId }) => issuanceRequestId === input.issuanceRequestId);
    if (replay !== undefined) {
      if (replay.revokedAt === undefined && matches(replay, input)) return replay;
      throw new NativeQemuAuthorityStateError("QEMU issuance request conflicts");
    }
    const current = [...state.attempts].reverse().find((attempt) => attempt.reviewId === input.reviewId
      && attempt.descriptor.jobName === input.descriptor.jobName && attempt.revokedAt === undefined);
    if (current !== undefined) throw new NativeQemuAuthorityStateError("QEMU job already has a current attempt");
    const attemptsForJob = state.attempts.filter((attempt) => attempt.reviewId === input.reviewId
      && attempt.descriptor.jobName === input.descriptor.jobName);
    const attempt = attemptSchema.parse({ schemaVersion: 1, executionKind: "qemu", ...input,
      attemptId: randomUUID(), attempt: attemptsForJob.length + 1, issuedAt: new Date().toISOString() });
    await this.save({ ...state, attempts: [...state.attempts, attempt] });
    return attempt;
  }
  async current(reviewId: string, jobName: string): Promise<NativeQemuAttemptRecord | undefined> {
    return [...(await this.load()).attempts].reverse().find((attempt) => attempt.reviewId === reviewId
      && attempt.descriptor.jobName === jobName && attempt.revokedAt === undefined);
  }
  async revoke(reviewId: string, jobName: string, attemptId: string): Promise<NativeQemuAttemptRecord> {
    const state = await this.load();
    const selected = state.attempts.find((attempt) => attempt.reviewId === reviewId
      && attempt.descriptor.jobName === jobName && attempt.attemptId === attemptId);
    if (selected === undefined) throw new NativeQemuAuthorityStateError("current QEMU attempt was not found");
    if (selected.revokedAt !== undefined) return selected;
    const revoked = attemptSchema.parse({ ...selected, revokedAt: new Date().toISOString() });
    await this.save({ ...state, attempts: state.attempts.map((attempt) => attempt.attemptId === attemptId ? revoked : attempt) });
    return revoked;
  }
  async status(record: NativeQemuStatusRecord): Promise<NativeQemuStatusRecord> {
    const status = statusSchema.parse(record);
    const state = await this.load();
    const existing = state.statuses.find(({ attemptId }) => attemptId === status.attemptId);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, status)) return existing;
      throw new NativeQemuAuthorityStateError("QEMU attempt already has another status");
    }
    const attempt = state.attempts.find(({ attemptId }) => attemptId === status.attemptId);
    if (attempt === undefined || attempt.revokedAt !== undefined || attempt.descriptorDigest !== status.descriptorDigest) {
      throw new NativeQemuAuthorityStateError("QEMU status does not match a current attempt");
    }
    await this.save({ ...state, statuses: [...state.statuses, status] });
    return status;
  }
  async snapshot(): Promise<{ readonly attempts: readonly NativeQemuAttemptRecord[];
    readonly statuses: readonly NativeQemuStatusRecord[] }> { return this.load(); }
  private async load(): Promise<State> {
    return (await readNativeQemuAuthorityStateFile(this.#repository, {
      parse: (value) => stateSchema.parse(value),
      isSuccessor
    })) ?? emptyState();
  }
  private async save(state: State): Promise<void> {
    const parsed = stateSchema.parse(state);
    await publishNativeQemuAuthorityState(this.#repository, `${JSON.stringify(parsed)}\n`, this.#faults);
  }
}

export async function assertNativeQemuAuthorityStore(repository: string): Promise<void> {
  await new NativeQemuAuthorityState(repository).snapshot();
}

function emptyState(): State {
  return { schemaVersion: 1, attempts: [], statuses: [] };
}

function isSuccessor(current: State | undefined, candidate: State): boolean {
  const previous = current ?? emptyState();
  const issue = candidate.attempts.length === previous.attempts.length + 1
    && isDeepStrictEqual(candidate.attempts.slice(0, -1), previous.attempts)
    && isDeepStrictEqual(candidate.statuses, previous.statuses);
  const status = candidate.statuses.length === previous.statuses.length + 1
    && isDeepStrictEqual(candidate.statuses.slice(0, -1), previous.statuses)
    && isDeepStrictEqual(candidate.attempts, previous.attempts);
  const revocation = candidate.attempts.length === previous.attempts.length
    && isDeepStrictEqual(candidate.statuses, previous.statuses)
    && candidate.attempts.filter((attempt, index) => !isDeepStrictEqual(attempt, previous.attempts[index])).length === 1
    && candidate.attempts.some((attempt, index) => isRevocation(previous.attempts[index], attempt));
  return issue || status || revocation;
}

function isRevocation(
  previous: NativeQemuAttemptRecord | undefined,
  candidate: NativeQemuAttemptRecord
): boolean {
  if (previous === undefined || previous.revokedAt !== undefined || candidate.revokedAt === undefined) return false;
  const { revokedAt: previousRevokedAt, ...previousIntent } = previous;
  const { revokedAt: candidateRevokedAt, ...candidateIntent } = candidate;
  return previousRevokedAt === undefined && candidateRevokedAt !== undefined
    && isDeepStrictEqual(previousIntent, candidateIntent);
}
function matches(attempt: NativeQemuAttemptRecord, input: { readonly reviewId: string;
  readonly descriptor: z.infer<typeof qemuExecutionDescriptorSchema>; readonly descriptorDigest: string;
  readonly hostId: string; readonly capacity: string }): boolean {
  return attempt.reviewId === input.reviewId && attempt.descriptorDigest === input.descriptorDigest
    && attempt.hostId === input.hostId && attempt.capacity === input.capacity
    && isDeepStrictEqual(attempt.descriptor, input.descriptor);
}
export class NativeQemuAuthorityStateError extends Error { readonly name = "NativeQemuAuthorityStateError"; }
