import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { BoundedJsonTransport, GitServiceRequest } from "@slop-lab/gs-client";
import { mapReviewNamespace } from "./dto.js";

type Credential = { readonly username: string; readonly password: string };
type TransportConfig = {
  readonly baseUrl: string;
  readonly reviewer: Credential;
  readonly promoter?: Credential;
};

export class NativeGitHttpError extends Error {
  readonly name = "NativeGitHttpError";
  constructor(readonly status: number) {
    super("native Git request failed");
  }
}

export class NativeGitClientError extends Error {
  readonly name = "NativeGitClientError";
}

export class NativeGitJsonTransport implements BoundedJsonTransport {
  private generationId: string | undefined;

  constructor(private readonly config: TransportConfig) {}

  setGeneration(generationId: string): void {
    this.generationId = generationId;
  }

  async request(request: GitServiceRequest): Promise<unknown> {
    const mapped = mapRequest(request);
    const value = await this.requestPath(mapped.path, mapped.method, mapped.body, request.responseLimitBytes, mapped.authority);
    return request.kind === "reviews.detail" ? mapReviewNamespace(value) : value;
  }

  requestIdentity(path: string, authority: "reviewer" | "promoter" = "reviewer"): Promise<unknown> {
    return this.requestPath(path, "GET", undefined, 64 * 1024, authority, true);
  }

  private async requestPath(
    path: string,
    method: "GET" | "POST" | "PATCH",
    value: unknown,
    responseLimitBytes: number,
    authority: "reviewer" | "promoter",
    identity = false,
  ): Promise<unknown> {
    const credential = authority === "promoter" ? this.config.promoter : this.config.reviewer;
    if (credential === undefined) throw new NativeGitHttpError(403);
    const url = new URL(path, this.config.baseUrl);
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value), "utf8");
    const response = await new Promise<{ readonly status: number; readonly bytes: Buffer }>((resolve, reject) => {
      const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = requester(url, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
          Accept: "application/json",
          ...(this.generationId === undefined ? {} : { "X-Dim-Generation-Id": this.generationId }),
          ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(body.length) }),
        },
        signal: AbortSignal.timeout(identity ? 5_000 : 90_000),
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > responseLimitBytes) outgoing.destroy(new NativeGitClientError("native Git response exceeded limit"));
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
      const parsed: unknown = JSON.parse(response.bytes.toString("utf8"));
      return parsed;
    } catch (cause) {
      throw new NativeGitClientError("native Git returned invalid JSON", { cause });
    }
  }
}

function mapRequest(request: GitServiceRequest): {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly body?: unknown;
  readonly authority: "reviewer" | "promoter";
} {
  const project = encodeURIComponent(request.selector.namespaceId);
  const repository = encodeURIComponent(request.selector.repositoryId);
  const base = `/v1/projects/${project}/repositories/${repository}`;
  switch (request.kind) {
    case "diff.read": return { method: "POST", path: `${base}/diff`, body: request.input, authority: "reviewer" };
    case "blame.line": return { method: "POST", path: `${base}/blame`, body: request.input, authority: "reviewer" };
    case "ci.status": return { method: "GET", path: `${base}/reviews/${encodeURIComponent(request.input.reviewId)}/ci`, authority: "reviewer" };
    case "pull-requests.list": return { method: "GET", path: `${base}/pull-requests`, authority: "reviewer" };
    case "pull-requests.create": return { method: "POST", path: `${base}/pull-requests`, body: request.input, authority: "reviewer" };
    case "pull-requests.detail": return { method: "GET", path: `${base}/pull-requests/${encodeURIComponent(request.input.pullRequestId)}`, authority: "reviewer" };
    case "pull-requests.update": {
      const { pullRequestId, ...body } = request.input;
      return { method: "PATCH", path: `${base}/pull-requests/${encodeURIComponent(pullRequestId)}`, body, authority: "reviewer" };
    }
    case "pull-requests.refresh": {
      const { pullRequestId, ...body } = request.input;
      return { method: "POST", path: `${base}/pull-requests/${encodeURIComponent(pullRequestId)}/refresh`, body, authority: "reviewer" };
    }
    case "pull-requests.comment": {
      const { pullRequestId, ...body } = request.input;
      return { method: "POST", path: `${base}/pull-requests/${encodeURIComponent(pullRequestId)}/comments`, body, authority: "reviewer" };
    }
    case "pull-requests.review": {
      const { pullRequestId, ...body } = request.input;
      return { method: "POST", path: `${base}/pull-requests/${encodeURIComponent(pullRequestId)}/review`, body, authority: "reviewer" };
    }
    case "reviews.list": return { method: "GET", path: `${base}/reviews`, authority: "reviewer" };
    case "reviews.detail": return { method: "GET", path: `${base}/reviews/${encodeURIComponent(request.input.reviewId)}`, authority: "reviewer" };
    case "reviews.resolve": return { method: "POST", path: `${base}/reviews/resolve`, body: { schemaVersion: 1, ...request.input }, authority: "reviewer" };
    case "reviews.approve": return { method: "POST", path: `${base}/reviews/${encodeURIComponent(request.input.reviewId)}/approvals`, body: { requestId: request.input.requestId }, authority: "reviewer" };
    case "reviews.revoke": return { method: "POST", path: `${base}/reviews/${encodeURIComponent(request.input.reviewId)}/revocations`, body: { approvalId: request.input.approvalId }, authority: "reviewer" };
    case "reviews.promote": return { method: "POST", path: `${base}/reviews/${encodeURIComponent(request.input.reviewId)}/promotions`, body: { schemaVersion: 1 }, authority: "promoter" };
    case "merges.prepare": return { method: "POST", path: `${base}/merges`, body: { schemaVersion: 1, ...request.input }, authority: "promoter" };
    case "sync": return { method: "POST", path: `${base}/sync/${request.input.action}`, body: { schemaVersion: 1, ...(request.input.protectedRef === undefined ? {} : { protectedRef: request.input.protectedRef }) }, authority: "reviewer" };
  }
}
