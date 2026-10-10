import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import {
  authoritativeOrdinaryStatusSchema,
  ordinaryTerminalEventDigest,
  type AuthoritativeOrdinaryStatus,
  type AuthoritativeOrdinaryTerminalEvent
} from "./authoritative-ordinary-status-schema.js";
import type { AdmissionVerifierHttpClient, AdmissionVerifierHttpResponse } from "./ordinary-admission-http.js";

const maximumBodyBytes = 64 * 1024;
const timeoutMilliseconds = 5_000;
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const generation = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const responseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  requestId: uuidV4,
  servingGenerationId: generation,
  projectId: z.string(),
  repositoryId: z.literal("root"),
  claimId: uuidV4,
  resultGenerationId: generation,
  serviceEpochId: uuidV4,
  admissionGeneration: uuidV4,
  rootSequence: z.number().int().nonnegative(),
  rootCommit: objectId,
  rootTree: objectId,
  cleanupResourceId: uuidV4,
  cleanupComplete: z.literal(true),
  terminalEventDigest: digest,
  statusAcknowledgementJson: z.string(),
  statusAcknowledgementDigest: digest,
  deliveredAt: z.number().int().nonnegative()
}).strict().readonly();

export type OrdinaryTerminalProvenance = {
  readonly ordinaryServiceId: string;
  readonly servingGenerationId: string;
  readonly claimId: string;
  readonly resultGenerationId: string;
  readonly serviceEpochId: string;
  readonly admissionGeneration: string;
  readonly rootSequence: number;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly cleanupResourceId: string;
  readonly cleanupComplete: true;
  readonly terminalEventDigest: string;
  readonly statusAcknowledgementJson: string;
  readonly statusAcknowledgementDigest: string;
  readonly deliveredAt: number;
};

type VerifyInput = {
  readonly config: NativeGitBundleConfig["ordinaryCi"];
  readonly generationId: string;
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly projectId: string;
  readonly root: { readonly sequence: number; readonly commit: string; readonly tree: string };
  readonly event: AuthoritativeOrdinaryTerminalEvent;
  readonly status: AuthoritativeOrdinaryStatus;
  readonly statusJson: string;
};

export async function verifyOrdinaryCurrentTerminal(input: VerifyInput): Promise<OrdinaryTerminalProvenance> {
  const requestId = randomUUID();
  const requestBody = JSON.stringify({
    schemaVersion: 1,
    requestId,
    generationId: input.generationId,
    terminalEvent: input.event
  });
  if (Buffer.byteLength(requestBody, "utf8") > maximumBodyBytes) {
    throw new OrdinaryCurrentTerminalProofConflictError();
  }
  let response: AdmissionVerifierHttpResponse;
  try {
    response = await input.httpClient.request({
      endpoint: input.config.endpoint,
      method: "POST",
      path: `/v1/projects/${input.projectId}/repositories/root/native-root-ci-result-proof/current-terminal`,
      authorization: basicAuthorization(input.config.query.username, input.config.query.password),
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMilliseconds)
    });
  } catch (error) {
    throw new OrdinaryCurrentTerminalProofUnavailableError({ cause: error });
  }
  if (response.statusCode === 404 || response.statusCode === 409) {
    throw new OrdinaryCurrentTerminalProofConflictError();
  }
  if (response.statusCode !== 200 || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumBodyBytes) {
    throw new OrdinaryCurrentTerminalProofUnavailableError();
  }
  const proof = parseResponse(response.body);
  const acknowledgement = parseAcknowledgement(proof.statusAcknowledgementJson);
  const acknowledgementDigest = `sha256:${createHash("sha256")
    .update(proof.statusAcknowledgementJson, "utf8").digest("hex")}`;
  if (proof.serviceId !== input.config.serviceId || proof.requestId !== requestId
    || proof.servingGenerationId !== input.generationId || proof.resultGenerationId !== input.generationId
    || proof.projectId !== input.projectId || proof.admissionGeneration !== input.event.payload.descriptor.admissionGeneration
    || proof.rootSequence !== input.root.sequence || proof.rootCommit !== input.root.commit || proof.rootTree !== input.root.tree
    || proof.rootCommit.length !== proof.rootTree.length || proof.cleanupResourceId !== proof.claimId
    || proof.terminalEventDigest !== ordinaryTerminalEventDigest(input.event)
    || proof.statusAcknowledgementDigest !== acknowledgementDigest
    || proof.statusAcknowledgementJson !== input.statusJson || !isDeepStrictEqual(acknowledgement, input.status)) {
    throw new OrdinaryCurrentTerminalProofConflictError();
  }
  return {
    ordinaryServiceId: proof.serviceId,
    servingGenerationId: proof.servingGenerationId,
    claimId: proof.claimId,
    resultGenerationId: proof.resultGenerationId,
    serviceEpochId: proof.serviceEpochId,
    admissionGeneration: proof.admissionGeneration,
    rootSequence: proof.rootSequence,
    rootCommit: proof.rootCommit,
    rootTree: proof.rootTree,
    cleanupResourceId: proof.cleanupResourceId,
    cleanupComplete: proof.cleanupComplete,
    terminalEventDigest: proof.terminalEventDigest,
    statusAcknowledgementJson: proof.statusAcknowledgementJson,
    statusAcknowledgementDigest: proof.statusAcknowledgementDigest,
    deliveredAt: proof.deliveredAt
  };
}

function parseResponse(body: Buffer): z.infer<typeof responseSchema> {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new OrdinaryCurrentTerminalProofConflictError({ cause: error });
    throw error;
  }
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new OrdinaryCurrentTerminalProofConflictError({ cause: parsed.error });
  if (Buffer.byteLength(parsed.data.statusAcknowledgementJson, "utf8") > maximumBodyBytes) {
    throw new OrdinaryCurrentTerminalProofConflictError();
  }
  return parsed.data;
}

function parseAcknowledgement(value: string): AuthoritativeOrdinaryStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OrdinaryCurrentTerminalProofConflictError({ cause: error });
    throw error;
  }
  const acknowledgement = authoritativeOrdinaryStatusSchema.safeParse(parsed);
  if (!acknowledgement.success) {
    throw new OrdinaryCurrentTerminalProofConflictError({ cause: acknowledgement.error });
  }
  return acknowledgement.data;
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export class OrdinaryCurrentTerminalProofConflictError extends Error {
  readonly name = "OrdinaryCurrentTerminalProofConflictError";
  constructor(options?: ErrorOptions) { super("ordinary current-terminal proof conflicts with local evidence", options); }
}

export class OrdinaryCurrentTerminalProofUnavailableError extends Error {
  readonly name = "OrdinaryCurrentTerminalProofUnavailableError";
  constructor(options?: ErrorOptions) { super("ordinary current-terminal proof is unavailable", options); }
}
