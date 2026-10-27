import { createHash } from "node:crypto";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readNativeProjectRegistrations, resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { authoritativeNativeReviewEnvelopeSchema, parseAuthoritativeNativeReviewEnvelope, type AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import { maximumRecordBytes as maximumReviewRecordBytes, saveAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import { acceptReviewPreparations, type CodeReviewRuntime } from "./plugin-api.js";
import { ownedReviewDirectory, publishReviewRecord, readReviewJson, recoverPublishedReviewStaging } from "./review-record-storage.js";

export const maximumProposalAcceptanceBytes = maximumReviewRecordBytes + 256;
const acceptanceSchema = z.object({ schemaVersion: z.literal(1), generationId: z.string().regex(/^[0-9a-f]{64}$/),
  envelope: authoritativeNativeReviewEnvelopeSchema }).strict().readonly();

/** Only a live proposal notification records this proof, before publishing its review. */
export async function stageProposalAcceptance(repository: string, generationId: string, envelope: AuthoritativeNativeReviewEnvelope): Promise<void> {
  const paths = await initialize(repository), record = acceptanceSchema.parse({ schemaVersion: 1, generationId, envelope });
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) > maximumProposalAcceptanceBytes) throw new ProposalAcceptanceError("proposal acceptance exceeds its storage bound");
  try { await publishReviewRecord({ path: join(paths.pending, name(generationId, envelope)), serialized, stagingRoot: paths.staging, faults: {} }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const previous = acceptanceSchema.parse(await readReviewJson(join(paths.pending, name(generationId, envelope)), maximumProposalAcceptanceBytes));
    if (previous.generationId !== generationId || previous.envelope.envelopeId !== envelope.envelopeId) throw new ProposalAcceptanceError("proposal acceptance conflicts");
  }
}

export async function completeProposalAcceptance(repository: string, generationId: string, envelope: AuthoritativeNativeReviewEnvelope): Promise<void> {
  const paths = await initialize(repository);
  await unlink(join(paths.pending, name(generationId, envelope)));
  const directory = await open(paths.pending, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Recovery resumes only an explicitly accepted action from this exact generation. */
export async function recoverProposalAcceptances(runtime: CodeReviewRuntime, stateDirectory: string): Promise<void> {
  for (const registration of readNativeProjectRegistrations(runtime.state)) {
    if (registration.phase !== "repository-prepared") continue;
    const repository = join(stateDirectory, registration.projectId, `${registration.repositoryId}.git`), paths = await initialize(repository);
    const entries = await readdir(paths.pending, { withFileTypes: true });
    if (entries.length > 100_000) throw new ProposalAcceptanceError("proposal acceptance capacity exceeded");
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) throw new ProposalAcceptanceError("invalid proposal acceptance path");
      const record = acceptanceSchema.parse(await readReviewJson(join(paths.pending, entry.name), maximumProposalAcceptanceBytes));
      const envelope = parseAuthoritativeNativeReviewEnvelope(record.envelope);
      if (entry.name !== name(record.generationId, envelope) || envelope.review.projectId !== registration.projectId
        || envelope.review.repositoryId !== registration.repositoryId) throw new ProposalAcceptanceError("proposal acceptance identity conflicts");
      if (record.generationId !== runtime.expectedGenerationId) continue;
      const current = { ...runtime, authoritativeTargetProofs: new Map() };
      const target = await resolveAuthoritativeNativeRepositoryTarget(current, { projectId: registration.projectId,
        repositoryId: registration.repositoryId, protectedRef: envelope.review.protectedRef });
      if (envelope.policyDigest !== target.imported.policyDigest || (await nativeHumanReviewStaleReasons(current, target, envelope.review)).length > 0) continue;
      for (const preparation of current.reviewPreparations ?? []) {
        const attachment = envelope.attachments.find(({ kind }) => kind === preparation.name);
        await preparation.assertCurrent?.({ runtime: current, review: envelope.review, ...(attachment === undefined ? {} : { attachment }) });
      }
      const stored = await saveAuthoritativeNativeReviewEnvelope(repository, envelope);
      await acceptReviewPreparations(current, stored, `proposal:${stored.review.reviewId}`);
      await completeProposalAcceptance(repository, record.generationId, envelope);
    }
  }
}

async function initialize(repository: string): Promise<{ readonly pending: string; readonly staging: string }> {
  const root = join(repository, "dim-proposal-acceptance"), paths = { pending: join(root, "pending"), staging: join(root, "staging") };
  await ownedReviewDirectory(root); await ownedReviewDirectory(paths.pending); await ownedReviewDirectory(paths.staging);
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.pending });
  return paths;
}
function name(generationId: string, envelope: AuthoritativeNativeReviewEnvelope): string {
  return `${createHash("sha256").update(JSON.stringify([generationId, envelope.envelopeId])).digest("hex")}.json`;
}
class ProposalAcceptanceError extends Error { readonly name = "ProposalAcceptanceError"; }
