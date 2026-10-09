import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AuthoritativeNativeReviewControllerError } from "./authoritative-native-review-controller.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";

const maximumBodyBytes = 64 * 1024;
const identifier = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const routePattern = new RegExp(
  `^/v1/projects/(${identifier})/repositories/root/native-root-ci-proof/(policy|review-event)$`
);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const generationId = digest;
const requestId = z.string().uuid();
const requestShape = { schemaVersion: z.literal(1), requestId, generationId } as const;
const policyRequestSchema = z.object(requestShape).strict().readonly();
const eventRequestSchema = z.object({ ...requestShape,
  importNonce: z.string().uuid(),
  policyDigest: digest,
  eventId: digest,
  reviewId: digest,
  executionKind: z.enum(["ordinary-sysbox", "qemu"]),
  jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)
}).strict().readonly();

type Credential = { readonly username: string; readonly password: string };
type ProofServiceInput = {
  readonly credential: Credential;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};
type ProofRoute = { readonly kind: "identity" }
  | { readonly kind: "policy" | "review-event"; readonly projectId: string };
type ProofEnvelopeInput = {
  readonly generationId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRootTarget>>;
};

export type NativeRootCiProofService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeRootCiProofService(input: ProofServiceInput): NativeRootCiProofService {
  return {
    async handle(request, response, url) {
      const route = proofRoute(request, url);
      if (route === undefined) return false;
      if (!basicAuthorized(request, input.credential)) {
        const known = input.knownCredentials.some((credential) => basicAuthorized(request, credential));
        send(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
        return true;
      }
      if (route.kind === "identity") {
        send(response, 200, { schemaVersion: 1, serviceId: "native-main",
          role: "native-root-ci-proof-reader",
          scope: ["imported-policy:read", "ordinary-review-event:read"],
          generationId: input.runtime.expectedGenerationId });
        return true;
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof NativeRootCiProofBodyError) {
          send(response, 400, { error: "proof request is invalid" });
          return true;
        }
        throw error;
      }
      const parsed = route.kind === "policy" ? policyRequestSchema.safeParse(body) : eventRequestSchema.safeParse(body);
      if (!parsed.success) {
        send(response, 400, { error: "proof request is invalid" });
        return true;
      }
      if (parsed.data.generationId !== input.runtime.expectedGenerationId) {
        send(response, 409, { error: "proof generation conflicts with service startup" });
        return true;
      }
      if (!input.runtime.activated() || !exactActivationIsBound(input.runtime.state,
        input.runtime.expectedGenerationId, input.runtime.activationTokenDigest)) {
        send(response, 503, { error: "native root CI proof is unavailable" });
        return true;
      }
      if (!readNativeProjectRegistrations(input.runtime.state).some(({ projectId }) => projectId === route.projectId)) {
        send(response, 404, { error: "not found" });
        return true;
      }
      try {
        if (route.kind === "policy") {
          const proof = await input.serialize(async () => {
            const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId: route.projectId });
            return proofEnvelope({ generationId: input.runtime.expectedGenerationId,
              requestId: parsed.data.requestId, projectId: route.projectId, target });
          });
          send(response, 200, proof);
          return true;
        }
        const selector = eventRequestSchema.parse(parsed.data);
        if (selector.executionKind === "qemu") {
          send(response, 404, { error: "not found" });
          return true;
        }
        const proof = await input.serialize(() => reviewEventProof(input.runtime, route.projectId, selector));
        if (proof === undefined) send(response, 404, { error: "not found" });
        else if (proof === "conflict") send(response, 409, { error: "proof tuple is stale" });
        else send(response, 200, proof);
      } catch (error) {
        if (error instanceof AuthoritativeNativeReviewControllerError) {
          send(response, 503, { error: "native root CI proof is unavailable" });
        } else if (error instanceof CandidateExecutionError) {
          send(response, 409, { error: "proof tuple is stale" });
        } else if (error instanceof Error) {
          send(response, 503, { error: "native root CI proof is unavailable" });
        } else {
          throw error;
        }
      }
      return true;
    }
  };
}

async function reviewEventProof(
  runtime: AuthoritativeNativeCandidateRuntime,
  projectId: string,
  selector: z.infer<typeof eventRequestSchema>
): Promise<Readonly<Record<string, unknown>> | "conflict" | undefined> {
  const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId });
  if (selector.importNonce !== target.imported.importNonce || selector.policyDigest !== target.imported.policyDigest) {
    return "conflict";
  }
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, selector.reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId || envelope.review.repositoryId !== "root") {
    return undefined;
  }
  const event = envelope.events.find((candidate) => candidate.eventId === selector.eventId
    && candidate.reviewId === selector.reviewId && candidate.executionKind === selector.executionKind
    && candidate.jobName === selector.jobName);
  if (event === undefined) return undefined;
  if ((await nativeHumanReviewStaleReasons(runtime, target, envelope.review)).length > 0) return "conflict";
  const confirmedTarget = await resolveAuthoritativeNativeRootTarget(runtime, { projectId });
  const confirmedEnvelope = await readAuthoritativeNativeReviewEnvelope(target.repository, selector.reviewId);
  if (JSON.stringify(confirmedTarget) !== JSON.stringify(target)
    || JSON.stringify(confirmedEnvelope) !== JSON.stringify(envelope)) return "conflict";
  return { ...proofEnvelope({ generationId: runtime.expectedGenerationId,
    requestId: selector.requestId, projectId, target }),
    reviewLiveness: "current", event };
}

function proofEnvelope(input: ProofEnvelopeInput): Readonly<Record<string, unknown>> {
  return { schemaVersion: 1, serviceId: "native-main", requestId: input.requestId,
    servingGenerationId: input.generationId, projectId: input.projectId, repositoryId: "root",
    currentRoot: { importNonce: input.target.imported.importNonce,
      sequence: input.target.currentHead.sequence, protectedRef: input.target.currentHead.protectedRef,
      commit: input.target.currentHead.commit, tree: input.target.currentHead.tree,
      policyDigest: input.target.currentHead.policyDigest }, policy: input.target.imported.policy };
}

function proofRoute(request: IncomingMessage, url: URL): ProofRoute | undefined {
  if (url.search !== "") return undefined;
  if (request.method === "GET" && url.pathname === "/v1/native-root-ci-proof/identity") return { kind: "identity" };
  if (request.method !== "POST") return undefined;
  const match = routePattern.exec(url.pathname);
  const projectId = match?.[1];
  const kind = match?.[2];
  return projectId !== undefined && (kind === "policy" || kind === "review-event") ? { kind, projectId } : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new NativeRootCiProofBodyError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new NativeRootCiProofBodyError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = `${JSON.stringify(body)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumBodyBytes) {
    response.writeHead(500, { "Cache-Control": "no-store" }).end();
    return;
  }
  response.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(serialized);
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

class NativeRootCiProofBodyError extends Error {
  readonly name = "NativeRootCiProofBodyError";
}
