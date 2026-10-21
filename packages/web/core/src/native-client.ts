import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { ReviewerWebConfig } from "./config.js";
import { reviewDto, type ReviewDto } from "./dto.js";

const MAX_NATIVE_RESPONSE_BYTES = 8 * 1024 * 1024;
const identitySchema = z.object({
  schemaVersion: z.literal(1), serviceId: z.literal("native-main"), role: z.literal("human-reviewer"),
  reviewerId: z.string(), generationId: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();
type NativeConfig = NonNullable<ReviewerWebConfig["nativeGit"]>;
type NativeRequest = { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown };

export class NativeGitClient {
  private generationId: string | undefined;
  constructor(private readonly config: NativeConfig) {}

  async attest(): Promise<void> {
    const identity = identitySchema.parse(await this.request({ method: "GET", path: "/v1/human-reviewer-identity" }));
    if (identity.reviewerId !== this.config.reviewerId || identity.generationId !== this.config.generationId) throw new NativeGitClientError("native Git human reviewer identity or control-plane generation does not match connection");
    this.generationId = identity.generationId;
    if (this.config.promoter !== undefined) {
      const promoter = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("native-main"), role: z.literal("host-promoter"), hostId: z.string(), generationId: z.string() }).strict()
        .parse(await this.request({ method: "GET", path: "/v1/host-promoter-identity" }, this.config.promoter));
      if (promoter.generationId !== identity.generationId || promoter.hostId !== this.config.promoter.hostId) throw new NativeGitClientError("promoter identity or generation conflicts");
    }
  }

  async listReviews(projectId: string, repositoryId: string) {
    return z.array(z.object({ reviewId: z.string().regex(/^[0-9a-f]{64}$/), proposalRef: z.string().max(1024), protectedRef: z.string().max(1024),
      candidateCommit: z.string().regex(/^[0-9a-f]{40,64}$/), createdAt: z.string().datetime(), status: z.string().max(64) }).strict()).max(100)
      .parse(await this.request({ method: "GET", path: `/v1/projects/${projectId}/repositories/${repositoryId}/reviews` }));
  }
  async promote(projectId: string, repositoryId: string, reviewId: string) {
    if (!this.config.promoter) throw new NativeGitHttpError(403);
    return z.object({ schemaVersion: z.literal(1), outcome: z.enum(["promoted", "already-current"]), reviewId: z.string(),
      protectedRef: z.string(), expectedProtectedHead: z.string(), candidateCommit: z.string(), candidateTree: z.string() }).strip()
      .parse(await this.request({ method: "POST", path: `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}/promotions`, body: { schemaVersion: 1 } }, this.config.promoter));
  }

  async getReview(projectId: string, repositoryId: string, reviewId: string): Promise<ReviewDto> {
    return this.decodeReview(await this.request({
      method: "GET",
      path: `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}`
    }));
  }

  async resolveReview(projectId: string, repositoryId: string, body: { proposalRef: string }): Promise<ReviewDto> {
    const result = z.object({ review: z.object({ reviewId: z.string().regex(/^[0-9a-f]{64}$/) }) }).parse(await this.request({
      method: "POST", path: `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/resolve`,
      body: { schemaVersion: 1, proposalRef: body.proposalRef }
    }));
    return this.getReview(projectId, repositoryId, result.review.reviewId);
  }

  async approveReview(projectId: string, repositoryId: string, reviewId: string): Promise<ReviewDto> {
    const path = `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}`;
    await this.request({ method: "POST", path: `${path}/approvals`, body: { requestId: randomUUID() } });
    return this.decodeReview(await this.request({ method: "GET", path }));
  }

  async revokeApproval(
    projectId: string,
    repositoryId: string,
    reviewId: string,
    approvalId: string
  ): Promise<ReviewDto> {
    const path = `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}`;
    await this.request({ method: "POST", path: `${path}/revocations`, body: { approvalId } });
    return this.decodeReview(await this.request({ method: "GET", path }));
  }

  private decodeReview(input: unknown): ReviewDto {
    try { return reviewDto(input); }
    catch (cause) { throw new NativeGitClientError("native Git returned invalid review evidence", { cause }); }
  }

  private async request(input: NativeRequest, credential = { username: this.config.username, password: this.config.password }): Promise<unknown> {
    const url = new URL(input.path, this.config.baseUrl);
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), "utf8");
    const response = await new Promise<{ readonly status: number; readonly bytes: Buffer }>((resolve, reject) => {
      const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = requester(url, {
        method: input.method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
          Accept: "application/json",
          ...(this.generationId === undefined ? {} : { "X-Dim-Generation-Id": this.generationId }),
          ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(body.length) })
        },
        signal: AbortSignal.timeout(5_000)
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_NATIVE_RESPONSE_BYTES) outgoing.destroy(new NativeGitClientError("native Git response exceeded limit"));
          else chunks.push(chunk);
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 503, bytes: Buffer.concat(chunks) }));
      });
      outgoing.on("error", (cause) => reject(new NativeGitClientError("native Git is unavailable", { cause })));
      outgoing.once("response", (incoming) => incoming.once("error", (cause) => reject(new NativeGitClientError("native Git response failed", { cause }))));
      outgoing.end(body);
    });
    if (response.status < 200 || response.status >= 300) throw new NativeGitHttpError(response.status);
    try {
      const value: unknown = JSON.parse(response.bytes.toString("utf8"));
      return value;
    } catch (error) {
      throw new NativeGitClientError("native Git returned invalid JSON", { cause: error });
    }
  }
}

export class NativeGitHttpError extends Error {
  readonly name = "NativeGitHttpError";
  constructor(readonly status: number) {
    super("native Git request failed");
  }
}

export class NativeGitClientError extends Error {
  readonly name = "NativeGitClientError";
}
