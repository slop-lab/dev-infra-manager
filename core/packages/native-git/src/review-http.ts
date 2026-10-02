import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { NativeGitIdentity } from "./config.js";
import { ciStatusEnvelopeSchema } from "./promotion-schema.js";
import type { PromotionService } from "./promotion-service.js";
import { ReviewApiError, type ReviewService } from "./review-service.js";

const MAX_BODY_BYTES = 64 * 1024;
const identifierPattern = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const collectionPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews$`);
const memberPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews/([0-9a-f]{64})(?:/(approvals|revocations|statuses|promotions))?$`);
const createSchema = z.object({
  protectedRef: z.string().min(1).max(1024),
  proposalRef: z.string().min(1).max(1024)
}).strict().readonly();
const emptySchema = z.object({}).strict().readonly();
const revokeSchema = z.object({ approvalId: z.string().uuid() }).strict().readonly();

export type ReviewHttpRoute =
  | { readonly kind: "create"; readonly projectId: string; readonly repositoryId: string }
  | { readonly kind: "get"; readonly projectId: string; readonly repositoryId: string; readonly reviewId: string }
  | { readonly kind: "approve"; readonly projectId: string; readonly repositoryId: string; readonly reviewId: string }
  | { readonly kind: "revoke"; readonly projectId: string; readonly repositoryId: string; readonly reviewId: string }
  | { readonly kind: "status"; readonly projectId: string; readonly repositoryId: string; readonly reviewId: string }
  | { readonly kind: "promote"; readonly projectId: string; readonly repositoryId: string; readonly reviewId: string };

export type ReviewApiServices = {
  readonly review: ReviewService;
  readonly promotion: PromotionService;
};

export function nativeGitReviewRoute(request: IncomingMessage): ReviewHttpRoute | undefined {
  const url = new URL(request.url ?? "/", "http://dim-native-git");
  if (url.search.length > 0) return undefined;
  const collection = collectionPattern.exec(url.pathname);
  if (collection !== null && request.method === "POST") {
    const projectId = collection[1];
    const repositoryId = collection[2];
    if (projectId !== undefined && repositoryId !== undefined) return { kind: "create", projectId, repositoryId };
  }
  const member = memberPattern.exec(url.pathname);
  if (member === null) return undefined;
  const projectId = member[1];
  const repositoryId = member[2];
  const reviewId = member[3];
  const action = member[4];
  if (projectId === undefined || repositoryId === undefined || reviewId === undefined) return undefined;
  if (request.method === "GET" && action === undefined) return { kind: "get", projectId, repositoryId, reviewId };
  if (request.method === "POST" && action === "approvals") return { kind: "approve", projectId, repositoryId, reviewId };
  if (request.method === "POST" && action === "revocations") return { kind: "revoke", projectId, repositoryId, reviewId };
  if (request.method === "POST" && action === "statuses") return { kind: "status", projectId, repositoryId, reviewId };
  if (request.method === "POST" && action === "promotions") return { kind: "promote", projectId, repositoryId, reviewId };
  return undefined;
}

export async function serveReviewApi(
  services: ReviewApiServices,
  identity: NativeGitIdentity,
  route: ReviewHttpRoute,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const target = { projectId: route.projectId, repositoryId: route.repositoryId };
    switch (route.kind) {
      case "create": {
        const input = createSchema.parse(await readBody(request));
        sendJson(response, 201, await services.review.create(identity, { ...target, ...input }));
        return;
      }
      case "get":
        sendJson(response, 200, await services.review.get(identity, target, route.reviewId));
        return;
      case "approve":
        emptySchema.parse(await readBody(request));
        sendJson(response, 201, await services.review.approve(identity, target, route.reviewId));
        return;
      case "revoke": {
        const input = revokeSchema.parse(await readBody(request));
        await services.review.revoke(identity, target, route.reviewId, input.approvalId);
        sendJson(response, 201, { approvalId: input.approvalId, reviewId: route.reviewId, revoked: true });
        return;
      }
      case "status": {
        const envelope = ciStatusEnvelopeSchema.parse(await readBody(request));
        sendJson(response, 201, await services.promotion.report(identity, target, route.reviewId, envelope));
        return;
      }
      case "promote": {
        emptySchema.parse(await readBody(request));
        const result = await services.promotion.promote(identity, target, route.reviewId);
        sendJson(response, result.outcome === "promoted" ? 201 : 200, result);
        return;
      }
      default:
        return assertNever(route);
    }
  } catch (error) {
    if (error instanceof ReviewApiError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof ReviewBodyError) {
      sendJson(response, 400, { error: "invalid review request" });
      return;
    }
    sendJson(response, 500, { error: "review operation failed" });
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new ReviewBodyError("review request must be JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ReviewBodyError("review request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function assertNever(value: never): never {
  throw new ReviewBodyError(`unexpected review route: ${JSON.stringify(value)}`);
}

class ReviewBodyError extends Error {
  readonly name = "ReviewBodyError";
}
