import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ordinaryAttemptStorePaths, readOrdinaryAttempts } from "./authoritative-ordinary-attempt-files.js";
import {
  authoritativeOrdinaryTerminalEventSchema,
  authoritativeOrdinaryStatusSchema,
  createAuthoritativeOrdinaryStatus,
  type AuthoritativeOrdinaryStatus,
  type AuthoritativeOrdinaryTerminalEvent
} from "./authoritative-ordinary-status-schema.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import {
  assertOwnedReviewDirectory,
  readReviewJson,
  readReviewRecord
} from "./review-record-storage.js";
import type { CurrentAuthoritativeOrdinaryAttempt } from "./authoritative-ordinary-attempt-store.js";
import {
  publishAuthoritativeOrdinaryStatus,
  readOrdinaryStatusDirectory,
  removeOrdinaryStatusStaging,
  type AuthoritativeOrdinaryStatusPublicationFaults
} from "./authoritative-ordinary-status-files.js";

const maximumRecordBytes = 256 * 1024;

export type { AuthoritativeOrdinaryStatusPublicationFaults } from "./authoritative-ordinary-status-files.js";

export type SaveAuthoritativeOrdinaryStatusResult = {
  readonly created: boolean;
  readonly status: AuthoritativeOrdinaryStatus;
};

export type CurrentAuthoritativeOrdinaryStatus = {
  readonly event: AuthoritativeOrdinaryTerminalEvent;
  readonly status: AuthoritativeOrdinaryStatus;
  readonly serialized: string;
};

type StatusSaveInput = {
  readonly reporterUsername: string;
  readonly faults: AuthoritativeOrdinaryStatusPublicationFaults;
};

export async function assertAuthoritativeOrdinaryStatusStore(repository: string): Promise<void> {
  const root = statusRoot(repository);
  if (!(await exists(root))) return;
  await assertPrivateDirectory(root);
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (rootEntries.length !== 1 || rootEntries[0]?.name !== "ordinary-sysbox" || !rootEntries[0].isDirectory()) {
    throw new AuthoritativeOrdinaryStatusStoreError("ordinary status store layout is invalid");
  }
  const { statuses, stagingPaths } = await readStatuses(repository);
  if (new Set(statuses.map(({ statusId }) => statusId)).size !== statuses.length
    || new Set(statuses.map(({ eventId }) => eventId)).size !== statuses.length) {
    throw new AuthoritativeOrdinaryStatusStoreError("ordinary status identity is duplicated");
  }
  const attempts = await readOrdinaryAttempts(ordinaryAttemptStorePaths(repository));
  await Promise.all(statuses.map(async (status) => {
    const attempt = attempts.find((candidate) => candidate.reviewId === status.reviewId
      && candidate.descriptor.jobName === status.payload.descriptor.jobName
      && candidate.attempt === status.payload.attempt);
    if (attempt === undefined || attempt.attemptId !== status.payload.attemptId
      || attempt.descriptorDigest !== status.payload.descriptorDigest || attempt.hostId !== status.payload.hostId
      || attempt.capacity !== status.payload.capacity || !isDeepStrictEqual(attempt.descriptor, status.payload.descriptor)) {
      throw new AuthoritativeOrdinaryStatusStoreError("ordinary status does not match its attempt");
    }
    const envelope = await readAuthoritativeNativeReviewEnvelope(repository, status.reviewId);
    if (envelope === undefined || envelope.review.projectId !== status.payload.descriptor.projectId
      || envelope.review.repositoryId !== status.payload.descriptor.repositoryId
      || !envelope.review.requiredJobs.some((job) => job.executionKind === "ordinary-sysbox"
        && job.jobName === status.payload.descriptor.jobName)) {
      throw new AuthoritativeOrdinaryStatusStoreError("ordinary status does not match its review");
    }
  }));
  await removeOrdinaryStatusStaging(stagingPaths);
}

export async function saveAuthoritativeOrdinaryStatus(
  repository: string,
  event: AuthoritativeOrdinaryTerminalEvent,
  reporterUsername: string
): Promise<SaveAuthoritativeOrdinaryStatusResult> {
  return saveStatus(repository, event, { reporterUsername, faults: {} });
}

export async function saveAuthoritativeOrdinaryStatusWithFaults(
  repository: string,
  event: AuthoritativeOrdinaryTerminalEvent,
  input: StatusSaveInput
): Promise<SaveAuthoritativeOrdinaryStatusResult> {
  return saveStatus(repository, event, input);
}

async function saveStatus(repository: string, event: AuthoritativeOrdinaryTerminalEvent,
  input: StatusSaveInput): Promise<SaveAuthoritativeOrdinaryStatusResult> {
  const status = createAuthoritativeOrdinaryStatus(event, input.reporterUsername, new Date().toISOString());
  const path = statusPath(repository, event.payload.reviewId, event.payload.descriptor.jobName, event.payload.attempt);
  await ensurePrivateDirectory(dirname(path));
  try {
    await publishAuthoritativeOrdinaryStatus(path, `${JSON.stringify(status)}\n`, input.faults);
    return { created: true, status };
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = authoritativeOrdinaryStatusSchema.parse(await readReviewJson(path, maximumRecordBytes, true));
    if (existing.statusId !== status.statusId || !isDeepStrictEqual(existing, { ...status, reportedAt: existing.reportedAt })) {
      throw new AuthoritativeOrdinaryStatusStoreError("ordinary job attempt already has a different status");
    }
    return { created: false, status: existing };
  }
}

export async function readExistingAuthoritativeOrdinaryStatus(
  repository: string,
  event: AuthoritativeOrdinaryTerminalEvent,
  reporterUsername: string
): Promise<SaveAuthoritativeOrdinaryStatusResult | undefined> {
  const path = statusPath(repository, event.payload.reviewId, event.payload.descriptor.jobName, event.payload.attempt);
  if (!(await exists(path))) return undefined;
  const existing = authoritativeOrdinaryStatusSchema.parse(await readReviewJson(path, maximumRecordBytes, true));
  const expected = createAuthoritativeOrdinaryStatus(event, reporterUsername, existing.reportedAt);
  if (!isDeepStrictEqual(existing, expected)) {
    throw new AuthoritativeOrdinaryStatusStoreError("ordinary job attempt already has a different status");
  }
  return { created: false, status: existing };
}

export async function readCurrentAuthoritativeOrdinaryStatus(
  repository: string,
  current: CurrentAuthoritativeOrdinaryAttempt,
  reporterUsername: string
): Promise<CurrentAuthoritativeOrdinaryStatus | undefined> {
  const attempt = current.attempt;
  const path = statusPath(repository, attempt.reviewId, attempt.descriptor.jobName, attempt.attempt);
  if (!(await exists(path))) return undefined;
  const record = await readReviewRecord(path, maximumRecordBytes, true);
  const status = authoritativeOrdinaryStatusSchema.parse(record.value);
  const event = authoritativeOrdinaryTerminalEventSchema.parse({
    schemaVersion: status.schemaVersion,
    eventId: status.eventId,
    occurredAt: status.occurredAt,
    eventType: status.eventType,
    payload: status.payload
  });
  if (status.reporterUsername !== reporterUsername || status.reviewId !== attempt.reviewId
    || event.payload.attemptId !== attempt.attemptId || event.payload.attempt !== attempt.attempt
    || event.payload.descriptorDigest !== attempt.descriptorDigest || event.payload.hostId !== attempt.hostId
    || event.payload.capacity !== attempt.capacity || !isDeepStrictEqual(event.payload.descriptor, attempt.descriptor)) {
    throw new AuthoritativeOrdinaryStatusStoreError("ordinary status does not match the current attempt");
  }
  return { event, status, serialized: record.serialized };
}

async function readStatuses(repository: string): Promise<{
  readonly statuses: readonly AuthoritativeOrdinaryStatus[];
  readonly stagingPaths: readonly string[];
}> {
  const kind = join(statusRoot(repository), "ordinary-sysbox");
  await assertPrivateDirectory(kind);
  const statuses: AuthoritativeOrdinaryStatus[] = [];
  const stagingPaths: string[] = [];
  for (const review of await directories(kind, /^[0-9a-f]{64}$/, "ordinary status review path is invalid")) {
    const reviewPath = join(kind, review);
    for (const job of await directories(reviewPath, /^[a-z][a-z0-9-]{0,62}$/, "ordinary status job path is invalid")) {
      const jobPath = join(reviewPath, job);
      const records = await readOrdinaryStatusDirectory(jobPath, review, job);
      statuses.push(...records.statuses);
      stagingPaths.push(...records.stagingPaths);
    }
  }
  return { statuses, stagingPaths };
}

async function directories(root: string, pattern: RegExp, message: string): Promise<readonly string[]> {
  await assertPrivateDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory() || !pattern.test(entry.name))) {
    throw new AuthoritativeOrdinaryStatusStoreError(message);
  }
  return entries.map(({ name }) => name).sort();
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const root = dirname(dirname(dirname(path)));
  const kind = dirname(dirname(path));
  for (const directory of [root, kind, dirname(path), path]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    await assertPrivateDirectory(directory);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  await assertOwnedReviewDirectory(path);
  const metadata = await lstat(path);
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new AuthoritativeOrdinaryStatusStoreError("ordinary status directory is not private");
  }
}

function statusRoot(repository: string): string {
  return join(repository, "dim-authoritative-statuses");
}

function statusPath(repository: string, reviewId: string, jobName: string, attempt: number): string {
  return join(statusRoot(repository), "ordinary-sysbox", reviewId, jobName, `${attempt}.json`);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AuthoritativeOrdinaryStatusStoreError extends Error {
  readonly name = "AuthoritativeOrdinaryStatusStoreError";
}
