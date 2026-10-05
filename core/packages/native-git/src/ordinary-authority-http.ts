import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { OrdinaryAuthorityAuthenticator } from "./auth.js";
import type { NativeGitServiceConfig } from "./config.js";
import { createJobAttemptStore } from "./job-attempt-store.js";
import { refSerializationKey, type RefSerializer } from "./ref-serializer.js";
import { createReviewStore } from "./review-store.js";
import {
  findPolicy,
  policyDigest,
  requiredReview,
  ReviewApiError,
  status
} from "./review-service.js";

const MAX_BODY_BYTES = 64 * 1024;
const identifier = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const routePattern = new RegExp(
  `^/v1/projects/(${identifier})/repositories/(${identifier})/ordinary-authority/(policy|review-event|current-attempt)$`
);
const requestId = z.string().uuid();
const policyRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId,
  protectedRef: z.string().min(1).max(1024)
}).strict().readonly();
const currentAttemptRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId,
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  jobName: z.string().regex(new RegExp(`^${identifier}$`)),
  attemptId: z.string().uuid()
}).strict().readonly();
const reviewEventRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId,
  eventId: z.string().uuid(),
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)
}).strict().readonly();

export type OrdinaryAuthorityRoute =
  | { readonly kind: "identity" }
  | { readonly kind: "policy"; readonly projectId: string; readonly repositoryId: string }
  | { readonly kind: "review-event"; readonly projectId: string; readonly repositoryId: string }
  | { readonly kind: "current-attempt"; readonly projectId: string; readonly repositoryId: string };

export type OrdinaryAuthorityService = {
  serve(route: OrdinaryAuthorityRoute, request: IncomingMessage, response: ServerResponse): Promise<void>;
};

export function ordinaryAuthorityRoute(request: IncomingMessage): OrdinaryAuthorityRoute | undefined {
  const url = new URL(request.url ?? "/", "http://dim-native-git");
  if (url.search !== "") return undefined;
  if (request.method === "GET" && url.pathname === "/v1/ordinary-authority/identity") return { kind: "identity" };
  if (request.method !== "POST") return undefined;
  const match = routePattern.exec(url.pathname);
  const projectId = match?.[1];
  const repositoryId = match?.[2];
  const kind = match?.[3];
  if (projectId === undefined || repositoryId === undefined) return undefined;
  if (kind === "policy" || kind === "review-event" || kind === "current-attempt") return { kind, projectId, repositoryId };
  return undefined;
}

export function createOrdinaryAuthorityService(
  config: NativeGitServiceConfig,
  serializer: RefSerializer,
  authenticator: OrdinaryAuthorityAuthenticator
): OrdinaryAuthorityService {
  return {
    async serve(route, request, response) {
      if (!authenticator.authenticate(request.headers)) {
        send(response, 401, undefined, { "WWW-Authenticate": 'Basic realm="DIM Ordinary Authority"' });
        return;
      }
      try {
        if (route.kind === "identity") {
          send(response, 200, {
            schemaVersion: 1,
            serviceId: config.serviceId,
            role: "ordinary-authority-reader",
            scope: ["policy:read", "review-event:read", "attempt:read"]
          });
          return;
        }
        if (route.kind === "policy") {
          const input = policyRequestSchema.parse(await readBody(request));
          const policy = findPolicy(config, route, input.protectedRef);
          if (policy === undefined) throw new ReviewApiError(404, "policy was not found");
          send(response, 200, {
            schemaVersion: 1,
            serviceId: config.serviceId,
            requestId: input.requestId,
            policy: {
              schemaVersion: 1,
              projectId: route.projectId,
              repositoryId: route.repositoryId,
              protectedRef: policy.protectedRef,
              policyRevision: policy.policyRevision,
              requiredReviewRevision: policy.requiredReviewRevision,
              requiredJobSetRevision: policy.requiredJobSetRevision,
              requiredJobs: [...policy.requiredJobNames].sort()
            }
          });
          return;
        }
        if (route.kind === "review-event") {
          const input = reviewEventRequestSchema.parse(await readBody(request));
          const review = await requiredReview(config, route, input.reviewId);
          const event = await serializer.run(
            refSerializationKey(route.projectId, route.repositoryId, review.protectedRef),
            async () => {
              const stored = await createReviewStore(join(
                config.storageRoot,
                route.projectId,
                `${route.repositoryId}.git`
              )).readOutboxEvent({
                eventId: input.eventId,
                reviewId: input.reviewId,
                jobName: input.jobName
              });
              if (stored === undefined) throw new ReviewApiError(404, "review event was not found");
              const currentReview = await requiredReview(config, route, input.reviewId);
              const currentStatus = await status(config, currentReview);
              if (currentStatus.status === "stale") throw new ReviewApiError(409, "review tuple is stale");
              return stored;
            }
          );
          send(response, 200, {
            schemaVersion: 1,
            serviceId: config.serviceId,
            requestId: input.requestId,
            event: event.event
          });
          return;
        }
        const input = currentAttemptRequestSchema.parse(await readBody(request));
        const review = await requiredReview(config, route, input.reviewId);
        const assignment = await serializer.run(
          refSerializationKey(route.projectId, route.repositoryId, review.protectedRef),
          async () => {
            const currentReview = await requiredReview(config, route, input.reviewId);
            const currentPolicy = findPolicy(config, route, currentReview.protectedRef);
            const reviewStatus = await status(config, currentReview);
            const store = createJobAttemptStore(join(
              config.storageRoot,
              route.projectId,
              `${route.repositoryId}.git`
            ));
            const current = await store.current(input.reviewId, input.jobName);
            if (currentPolicy === undefined || reviewStatus.status === "stale"
              || policyDigest(currentPolicy) !== currentReview.policyDigest
              || !currentPolicy.requiredJobNames.includes(input.jobName)
              || current === undefined || current.revocation !== undefined
              || current.issuance.attemptId !== input.attemptId
              || current.issuance.reviewId !== currentReview.reviewId
              || current.issuance.descriptor.projectId !== currentReview.projectId
              || current.issuance.descriptor.repositoryId !== currentReview.repositoryId
              || current.issuance.descriptor.protectedRef !== currentReview.protectedRef
              || current.issuance.descriptor.expectedProtectedHead !== currentReview.expectedProtectedHead
              || current.issuance.descriptor.candidateCommit !== currentReview.candidateCommit
              || current.issuance.descriptor.candidateTree !== currentReview.candidateTree
              || current.issuance.descriptor.policyRevision !== currentPolicy.policyRevision
              || current.issuance.descriptor.requiredReviewRevision !== currentPolicy.requiredReviewRevision
              || current.issuance.descriptor.requiredJobSetRevision !== currentPolicy.requiredJobSetRevision) {
              throw new ReviewApiError(404, "current attempt was not found");
            }
            return {
              schemaVersion: 1,
              reviewId: current.issuance.reviewId,
              attemptId: current.issuance.attemptId,
              descriptor: current.issuance.descriptor,
              descriptorDigest: current.issuance.descriptorDigest,
              admissionGeneration: current.issuance.descriptor.admissionGeneration,
              hostId: current.issuance.hostId,
              capacity: current.issuance.capacity
            };
          }
        );
        send(response, 200, {
          schemaVersion: 1,
          serviceId: config.serviceId,
          requestId: input.requestId,
          assignment
        });
      } catch (error) {
        if (error instanceof ReviewApiError) send(response, error.status);
        else if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof AuthorityBodyError) {
          send(response, 400);
        } else send(response, 500);
      }
    }
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new AuthorityBodyError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AuthorityBodyError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(
  response: ServerResponse,
  statusCode: number,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  const serialized = body === undefined ? undefined : `${JSON.stringify(body)}\n`;
  if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
    response.writeHead(500, { "Cache-Control": "no-store" }).end();
    return;
  }
  const contentHeaders = body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" };
  response.writeHead(statusCode, { "Cache-Control": "no-store", ...contentHeaders, ...headers });
  response.end(serialized);
}

class AuthorityBodyError extends Error {
  readonly name = "AuthorityBodyError";
}
