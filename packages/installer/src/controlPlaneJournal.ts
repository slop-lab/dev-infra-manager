import { basename, join } from "node:path";
import type { ControlPlaneCandidateGeneration, ControlPlaneStaging } from "./controlPlaneGeneration.js";
import { readStateFile, removeStateFile, replaceStateFile } from "./controlPlaneStateFs.js";

type JournalPhase = "staging" | "generation" | "publishing" | "failed-first-install";

export async function writeControlPlaneJournal(
  staging: ControlPlaneStaging,
  phase: JournalPhase,
  generationId?: string
): Promise<void> {
  const value = {
    schemaVersion: 1,
    transactionId: staging.transactionId,
    phase,
    stagingDirectory: basename(staging.path),
    candidateGenerationId: generationId ?? null,
    prior: staging.prior === undefined ? null : {
      generationId: staging.prior.record.generationId,
      installBase64: staging.prior.installBytes.toString("base64"),
      composeBase64: staging.prior.composeBytes.toString("base64")
    }
  };
  await replaceStateFile(join(staging.root, "transaction.json"), Buffer.from(`${JSON.stringify(value)}\n`));
}

export async function markControlPlanePublication(candidate: ControlPlaneCandidateGeneration): Promise<void> {
  await writeControlPlaneJournal(candidate.staging, "publishing", candidate.generationId);
}

export async function completeControlPlanePublication(candidate: ControlPlaneCandidateGeneration): Promise<void> {
  const journalPath = join(candidate.staging.root, "transaction.json");
  const journal = await readStateFile(journalPath, 0o600, 4 * 1024 * 1024);
  const expected: unknown = JSON.parse(journal.toString("utf8"));
  const prior = isRecord(expected) && isRecord(expected.prior) ? expected.prior : undefined;
  const expectedPrior = candidate.staging.prior;
  if (!isRecord(expected) || Object.keys(expected).length !== 6 || expected.schemaVersion !== 1
    || expected.transactionId !== candidate.staging.transactionId
    || expected.phase !== "publishing" || expected.stagingDirectory !== basename(candidate.staging.path)
    || expected.candidateGenerationId !== candidate.generationId
    || (expectedPrior === undefined ? expected.prior !== null : prior === undefined
      || Object.keys(prior).length !== 3 || prior.generationId !== expectedPrior.record.generationId
      || prior.installBase64 !== expectedPrior.installBytes.toString("base64")
      || prior.composeBase64 !== expectedPrior.composeBytes.toString("base64"))) {
    throw new ControlPlaneJournalError("control-plane publication journal does not match the activated generation");
  }
  await removeStateFile(journalPath);
}

export async function completeControlPlaneRollback(candidate: ControlPlaneCandidateGeneration): Promise<void> {
  const journalPath = join(candidate.staging.root, "transaction.json");
  const journal = await readStateFile(journalPath, 0o600, 4 * 1024 * 1024);
  const expected: unknown = JSON.parse(journal.toString("utf8"));
  const prior = isRecord(expected) && isRecord(expected.prior) ? expected.prior : undefined;
  if (!isRecord(expected) || Object.keys(expected).length !== 6 || expected.schemaVersion !== 1
    || expected.transactionId !== candidate.staging.transactionId
    || (expected.phase !== "generation" && expected.phase !== "publishing")
    || expected.stagingDirectory !== basename(candidate.staging.path)
    || expected.candidateGenerationId !== candidate.generationId || candidate.staging.prior === undefined
    || prior === undefined || Object.keys(prior).length !== 3
    || prior.generationId !== candidate.staging.prior.record.generationId
    || prior.installBase64 !== candidate.staging.prior.installBytes.toString("base64")
    || prior.composeBase64 !== candidate.staging.prior.composeBytes.toString("base64")) {
    throw new ControlPlaneJournalError("control-plane rollback journal does not match the failed update");
  }
  await removeStateFile(journalPath);
}

export async function markFailedFirstControlPlaneInstall(candidate: ControlPlaneCandidateGeneration): Promise<void> {
  if (candidate.staging.prior !== undefined) {
    throw new ControlPlaneJournalError("failed-first-install recovery cannot describe an update");
  }
  await writeControlPlaneJournal(candidate.staging, "failed-first-install", candidate.generationId);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlPlaneJournalError extends Error {
  readonly name = "ControlPlaneJournalError";
}
