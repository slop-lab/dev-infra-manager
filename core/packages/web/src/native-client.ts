import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { ReviewerWebConfig } from "./config.js";
import { reviewDto, type ReviewDto } from "./dto.js";

const MAX_NATIVE_RESPONSE_BYTES = 8 * 1024 * 1024;
const identitySchema = z.object({
  role: z.literal("reviewer"),
  projectId: z.string(),
  repositoryIds: z.array(z.string()).readonly(),
  reviewerId: z.string()
}).strict().readonly();
type NativeConfig = ReviewerWebConfig["nativeGit"];
type NativeRequest = { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown };

export class NativeGitClient {
  constructor(private readonly config: NativeConfig) {}

  async attest(): Promise<void> {
    const identity = identitySchema.parse(await this.request({ method: "GET", path: "/v1/identity" }));
    const exactRepositories = identity.repositoryIds.length === this.config.repositoryIds.length
      && identity.repositoryIds.every((repositoryId, index) => repositoryId === this.config.repositoryIds[index]);
    if (identity.projectId !== this.config.projectId || identity.reviewerId !== this.config.reviewerId || !exactRepositories) {
      throw new NativeGitClientError("native Git reviewer identity does not match configured scope");
    }
  }

  async getReview(projectId: string, repositoryId: string, reviewId: string): Promise<ReviewDto> {
    return reviewDto(await this.request({
      method: "GET",
      path: `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}`
    }));
  }

  async createReview(projectId: string, repositoryId: string, body: unknown): Promise<ReviewDto> {
    return reviewDto(await this.request({
      method: "POST",
      path: `/v1/projects/${projectId}/repositories/${repositoryId}/reviews`,
      body
    }));
  }

  async approveReview(projectId: string, repositoryId: string, reviewId: string): Promise<ReviewDto> {
    const path = `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}`;
    await this.request({ method: "POST", path: `${path}/approvals`, body: {} });
    return reviewDto(await this.request({ method: "GET", path }));
  }

  async revokeApproval(
    projectId: string,
    repositoryId: string,
    reviewId: string,
    approvalId: string
  ): Promise<ReviewDto> {
    const path = `/v1/projects/${projectId}/repositories/${repositoryId}/reviews/${reviewId}`;
    await this.request({ method: "POST", path: `${path}/revocations`, body: { approvalId } });
    return reviewDto(await this.request({ method: "GET", path }));
  }

  private async request(input: NativeRequest): Promise<unknown> {
    const url = new URL(input.path, this.config.baseUrl);
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), "utf8");
    const response = await new Promise<{ readonly status: number; readonly bytes: Buffer }>((resolve, reject) => {
      const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = requester(url, {
        method: input.method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
          Accept: "application/json",
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
      outgoing.on("error", reject);
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
