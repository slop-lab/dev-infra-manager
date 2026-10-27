import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readNativeProjectRegistrations, resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { authoritativeNativeReviewEnvelopeSchema, parseAuthoritativeNativeReviewEnvelope, type AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import { maximumRecordBytes as maximumReviewRecordBytes, readAuthoritativeNativeReviewEnvelope,
  saveAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import { acceptReviewPreparations, type CodeReviewRuntime } from "./plugin-api.js";
import * as acceptanceStorage from "./proposal-acceptance-storage.js";
import {
  initializeProposalAcceptanceStorage,
  readProposalAcceptanceNames,
  removeProposalAcceptanceRecord,
  syncProposalAcceptanceDirectory,
  withProposalAcceptanceOperation,
  type ProposalAcceptancePaths
} from "./proposal-acceptance-storage.js";
import { publishReviewRecord, readReviewJson } from "./review-record-storage.js";

export const maximumProposalAcceptanceBytes = maximumReviewRecordBytes + 256;
const maximumProposalAcceptances = 100_000;
const acceptanceSchema = z.object({ schemaVersion: z.literal(1), generationId: z.string().regex(/^[0-9a-f]{64}$/),
  envelope: authoritativeNativeReviewEnvelopeSchema }).strict().readonly();
const failedAcceptanceSchema = z.object({ schemaVersion: z.literal(1) }).strict().readonly();

/** Only a live proposal notification records this proof, before publishing its review. */
export async function stageProposalAcceptance(repository: string, generationId: string, envelope: AuthoritativeNativeReviewEnvelope): Promise<void> {
  const record = acceptanceSchema.parse({ schemaVersion: 1, generationId, envelope });
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) > maximumProposalAcceptanceBytes) throw new ProposalAcceptanceError("proposal acceptance exceeds its storage bound");
  await withProposalAcceptanceOperation(repository, async () => {
    const paths = await initialize(repository);
    const recordName = name(generationId, envelope);
    const admission = await acceptanceStorage.admitProposalAcceptanceRecord(
      paths.pending, recordName, maximumProposalAcceptances
    );
    if (admission === "existing") {
      const previous = acceptanceSchema.parse(await readReviewJson(
        join(paths.pending, recordName), maximumProposalAcceptanceBytes
      ));
      if (previous.generationId !== generationId || previous.envelope.envelopeId !== envelope.envelopeId) {
        throw new ProposalAcceptanceError("proposal acceptance conflicts");
      }
    }
    if (await removeProposalAcceptanceRecord(join(paths.failed, recordName))) {
      await syncProposalAcceptanceDirectory(paths.failed);
    }
    if (admission === "existing") return;
    try {
      await publishReviewRecord({ path: join(paths.pending, recordName), serialized,
        stagingRoot: paths.staging, faults: {} });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const previous = acceptanceSchema.parse(await readReviewJson(
        join(paths.pending, recordName), maximumProposalAcceptanceBytes
      ));
      if (previous.generationId !== generationId || previous.envelope.envelopeId !== envelope.envelopeId) {
        throw new ProposalAcceptanceError("proposal acceptance conflicts");
      }
    }
  });
}

export async function completeProposalAcceptance(repository: string, generationId: string, envelope: AuthoritativeNativeReviewEnvelope): Promise<void> {
  await withProposalAcceptanceOperation(repository, async () => {
    const paths = await initialize(repository);
    const matching = await matchingAcceptanceNames(paths, generationId, envelope);
    let failedChanged = false;
    let pendingChanged = false;
    for (const recordName of matching.names) {
      failedChanged = await removeProposalAcceptanceRecord(join(paths.failed, recordName)) || failedChanged;
      pendingChanged = await removeProposalAcceptanceRecord(join(paths.pending, recordName)) || pendingChanged;
    }
    if (failedChanged) await syncProposalAcceptanceDirectory(paths.failed);
    if (pendingChanged) await syncProposalAcceptanceDirectory(paths.pending);
  });
}

export async function failProposalAcceptance(repository: string, generationId: string, envelope: AuthoritativeNativeReviewEnvelope): Promise<void> {
  await withProposalAcceptanceOperation(repository, async () => {
    const paths = await initialize(repository);
    const recordName = name(generationId, envelope);
    const pending = await readAcceptanceRecordIfPresent(join(paths.pending, recordName));
    if (pending === undefined) return;
    if (pending.generationId !== generationId || pending.envelope.envelopeId !== envelope.envelopeId) {
      throw new ProposalAcceptanceError("proposal acceptance conflicts");
    }
    const admission = await acceptanceStorage.admitProposalAcceptanceRecord(
      paths.failed, recordName, maximumProposalAcceptances
    );
    if (admission === "existing") {
      failedAcceptanceSchema.parse(await readReviewJson(join(paths.failed, recordName), maximumProposalAcceptanceBytes));
      return;
    }
    try {
      await publishReviewRecord({ path: join(paths.failed, recordName), serialized: `${JSON.stringify({ schemaVersion: 1 })}\n`,
        stagingRoot: paths.failedStaging, faults: {} });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  });
}

export type ProposalAcceptanceState = "none" | "pending" | "failed";

export async function proposalAcceptanceState(
  repository: string,
  generationId: string,
  envelope: AuthoritativeNativeReviewEnvelope
): Promise<ProposalAcceptanceState> {
  return withProposalAcceptanceOperation(repository, async () => {
    const paths = await initialize(repository);
    const matching = await matchingAcceptanceNames(paths, generationId, envelope);
    if (matching.names.some((recordName) => matching.failedNames.has(recordName))) return "failed";
    return matching.names.length === 0 ? "none" : "pending";
  });
}

export async function hasPendingProposalAcceptance(
  repository: string,
  generationId: string,
  envelope: AuthoritativeNativeReviewEnvelope
): Promise<boolean> {
  return await proposalAcceptanceState(repository, generationId, envelope) !== "none";
}

/** Recovery resumes only an explicitly accepted action from this exact generation. */
export async function recoverProposalAcceptances(
  runtime: CodeReviewRuntime,
  stateDirectory: string,
  finalize?: ProposalAcceptanceFinalizer
): Promise<void> {
  for (const registration of readNativeProjectRegistrations(runtime.state)) {
    if (registration.phase !== "repository-prepared") continue;
    const repository = join(stateDirectory, registration.projectId, `${registration.repositoryId}.git`);
    const records = await captureRecoveryRecords(repository, {
      projectId: registration.projectId,
      repositoryId: registration.repositoryId,
      generationId: runtime.expectedGenerationId
    });
    for (const record of records) {
      const { envelope } = record;
      const recover = async (): Promise<void> => {
        const current = { ...runtime, authoritativeTargetProofs: new Map() };
        const target = await resolveAuthoritativeNativeRepositoryTarget(current, { projectId: registration.projectId,
          repositoryId: registration.repositoryId, protectedRef: envelope.review.protectedRef });
        if (envelope.policyDigest !== target.imported.policyDigest
          || (await nativeHumanReviewStaleReasons(current, target, envelope.review)).length > 0) return;
        for (const preparation of current.reviewPreparations ?? []) {
          const attachment = envelope.attachments.find(({ kind }) => kind === preparation.name);
          await preparation.assertCurrent?.({ runtime: current, review: envelope.review,
            ...(attachment === undefined ? {} : { attachment }) });
        }
        const stored = await saveAuthoritativeNativeReviewEnvelope(repository, envelope);
        try {
          await acceptReviewPreparations(current, stored, `proposal:${stored.review.reviewId}`);
        } catch {
          await failProposalAcceptance(repository, record.generationId, envelope);
          return;
        }
        const complete = async (): Promise<void> => {
          const finalRuntime = { ...runtime, authoritativeTargetProofs: new Map() };
          const target = await resolveAuthoritativeNativeRepositoryTarget(finalRuntime, { projectId: registration.projectId,
            repositoryId: registration.repositoryId, protectedRef: envelope.review.protectedRef });
          const stored = await readAuthoritativeNativeReviewEnvelope(repository, envelope.review.reviewId);
          if (stored?.envelopeId !== envelope.envelopeId || envelope.policyDigest !== target.imported.policyDigest
            || (await nativeHumanReviewStaleReasons(finalRuntime, target, envelope.review)).length > 0) return;
          for (const preparation of finalRuntime.reviewPreparations ?? []) {
            const attachment = envelope.attachments.find(({ kind }) => kind === preparation.name);
            await preparation.assertCurrent?.({ runtime: finalRuntime, review: envelope.review,
              ...(attachment === undefined ? {} : { attachment }) });
          }
          await completeProposalAcceptance(repository, record.generationId, envelope);
        };
        if (finalize === undefined) await complete();
        else await finalize({ projectId: registration.projectId, repositoryId: registration.repositoryId }, complete);
      };
      await recover();
    }
  }
}

export type ProposalAcceptanceFinalizer = (
  scope: { readonly projectId: string; readonly repositoryId: string },
  operation: () => Promise<void>
) => Promise<void>;

type AcceptanceRecord = z.infer<typeof acceptanceSchema>;

async function initialize(repository: string): Promise<ProposalAcceptancePaths> {
  return initializeProposalAcceptanceStorage(repository, maximumProposalAcceptanceBytes);
}

async function captureRecoveryRecords(
  repository: string,
  identity: { readonly projectId: string; readonly repositoryId: string; readonly generationId: string }
): Promise<readonly AcceptanceRecord[]> {
  return withProposalAcceptanceOperation(repository, async () => {
    const paths = await initialize(repository);
    const names = await readProposalAcceptanceNames(paths.pending);
    if (names.length > maximumProposalAcceptances) {
      throw new ProposalAcceptanceError("proposal acceptance capacity exceeded");
    }
    const records: AcceptanceRecord[] = [];
    for (const recordName of names) {
      const record = acceptanceSchema.parse(await readReviewJson(
        join(paths.pending, recordName), maximumProposalAcceptanceBytes
      ));
      const envelope = parseAuthoritativeNativeReviewEnvelope(record.envelope);
      if (recordName !== name(record.generationId, envelope) || envelope.review.projectId !== identity.projectId
        || envelope.review.repositoryId !== identity.repositoryId) {
        throw new ProposalAcceptanceError("proposal acceptance identity conflicts");
      }
      if (record.generationId === identity.generationId) records.push({ ...record, envelope });
    }
    return records;
  });
}

async function readAcceptanceRecordIfPresent(path: string): Promise<AcceptanceRecord | undefined> {
  try {
    return acceptanceSchema.parse(await readReviewJson(path, maximumProposalAcceptanceBytes));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function matchingAcceptanceNames(
  paths: ProposalAcceptancePaths,
  generationId: string,
  envelope: AuthoritativeNativeReviewEnvelope
): Promise<{ readonly names: readonly string[]; readonly failedNames: ReadonlySet<string> }> {
  const entries = await readProposalAcceptanceNames(paths.pending);
  if (entries.length > maximumProposalAcceptances) throw new ProposalAcceptanceError("proposal acceptance capacity exceeded");
  const matching: string[] = [];
  for (const recordName of entries) {
    const record = acceptanceSchema.parse(await readReviewJson(join(paths.pending, recordName), maximumProposalAcceptanceBytes));
    if (recordName !== name(record.generationId, record.envelope)) {
      throw new ProposalAcceptanceError("proposal acceptance identity conflicts");
    }
    if (record.envelope.envelopeId === envelope.envelopeId) matching.push(recordName);
  }
  const failedEntries = await readProposalAcceptanceNames(paths.failed);
  if (failedEntries.length > maximumProposalAcceptances) throw new ProposalAcceptanceError("proposal acceptance capacity exceeded");
  const failedNames = new Set<string>();
  for (const recordName of failedEntries) {
    failedAcceptanceSchema.parse(await readReviewJson(join(paths.failed, recordName), maximumProposalAcceptanceBytes));
    failedNames.add(recordName);
  }
  const currentName = name(generationId, envelope);
  if (failedNames.has(currentName) && !matching.includes(currentName)) matching.push(currentName);
  return { names: matching, failedNames };
}
function name(generationId: string, envelope: AuthoritativeNativeReviewEnvelope): string {
  return `${createHash("sha256").update(JSON.stringify([generationId, envelope.envelopeId])).digest("hex")}.json`;
}
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
class ProposalAcceptanceError extends Error { readonly name = "ProposalAcceptanceError"; }
