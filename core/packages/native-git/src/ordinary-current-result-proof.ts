import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import {
  authoritativeOrdinaryTerminalEventSchema,
  ordinaryTerminalEventDigest,
  type AuthoritativeOrdinaryTerminalEvent
} from "./authoritative-ordinary-status-schema.js";
import type { AdmissionVerifierHttpClient, AdmissionVerifierHttpResponse } from "./ordinary-admission-http.js";

const maximumResponseBytes = 64 * 1024;
const timeoutMilliseconds = 5_000;
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const responseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  requestId: z.string().uuid(),
  servingGenerationId: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: z.string(),
  repositoryId: z.literal("root"),
  claimId: z.string().uuid(),
  serviceEpochId: z.string().uuid(),
  admissionGeneration: z.string(),
  rootSequence: z.number().int().nonnegative(),
  rootCommit: objectId,
  rootTree: objectId,
  cleanupComplete: z.literal(true),
  terminalEvent: authoritativeOrdinaryTerminalEventSchema,
  terminalEventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
}).strict().readonly();

type ExpectedRoot = {
  readonly sequence: number;
  readonly commit: string;
  readonly tree: string;
};

type VerifyInput = {
  readonly config: NativeGitBundleConfig["ordinaryCi"];
  readonly generationId: string;
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly projectId: string;
  readonly root: ExpectedRoot;
  readonly event: AuthoritativeOrdinaryTerminalEvent;
};

export async function verifyOrdinaryCurrentResult(input: VerifyInput): Promise<void> {
  const requestId = randomUUID();
  const requestBody = JSON.stringify({
    schemaVersion: 1,
    requestId,
    generationId: input.generationId,
    terminalEvent: input.event
  });
  let response: AdmissionVerifierHttpResponse;
  try {
    response = await input.httpClient.request({
      endpoint: input.config.endpoint,
      method: "POST",
      path: `/v1/projects/${input.projectId}/repositories/root/native-root-ci-result-proof/current-result`,
      authorization: basicAuthorization(input.config.query.username, input.config.query.password),
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMilliseconds)
    });
  } catch (error) {
    throw new OrdinaryCurrentResultProofUnavailableError({ cause: error });
  }
  if (response.statusCode === 404 || response.statusCode === 409) throw new OrdinaryCurrentResultProofConflictError();
  if (response.statusCode !== 200 || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new OrdinaryCurrentResultProofUnavailableError();
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new OrdinaryCurrentResultProofUnavailableError({ cause: error });
    throw error;
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new OrdinaryCurrentResultProofConflictError({ cause: parsed.error });
  const proof = parsed.data;
  if (proof.serviceId !== input.config.serviceId || proof.requestId !== requestId
    || proof.servingGenerationId !== input.generationId || proof.projectId !== input.projectId
    || proof.admissionGeneration !== input.event.payload.descriptor.admissionGeneration
    || proof.rootSequence !== input.root.sequence || proof.rootCommit !== input.root.commit || proof.rootTree !== input.root.tree
    || !isDeepStrictEqual(proof.terminalEvent, input.event)
    || proof.terminalEventDigest !== ordinaryTerminalEventDigest(input.event)) {
    throw new OrdinaryCurrentResultProofConflictError();
  }
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export class OrdinaryCurrentResultProofConflictError extends Error {
  readonly name = "OrdinaryCurrentResultProofConflictError";
  constructor(options?: ErrorOptions) { super("ordinary current-result proof conflicts with the terminal event", options); }
}

export class OrdinaryCurrentResultProofUnavailableError extends Error {
  readonly name = "OrdinaryCurrentResultProofUnavailableError";
  constructor(options?: ErrorOptions) { super("ordinary current-result proof is unavailable", options); }
}
