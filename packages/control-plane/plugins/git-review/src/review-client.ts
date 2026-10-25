import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 90_000;

export type ReviewClientCredentials = {
  readonly username: string;
  readonly password: string;
};

export type ReviewClientRequest = {
  readonly baseUrl: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly credentials: ReviewClientCredentials;
  readonly body?: unknown;
  readonly generationId?: string;
};

export async function requestReviewApi(input: ReviewClientRequest): Promise<string> {
  const baseUrl = new URL(input.baseUrl);
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || baseUrl.username.length > 0
    || baseUrl.password.length > 0 || baseUrl.search.length > 0 || baseUrl.hash.length > 0
    || (baseUrl.pathname !== "/" && baseUrl.pathname !== "")) {
    throw new ReviewClientError("review API URL must be an HTTP or HTTPS origin without credentials");
  }
  const target = new URL(input.path, baseUrl);
  const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), "utf8");
  const response = await new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(target, {
      method: input.method,
      signal: AbortSignal.timeout(input.path.endsWith("-identity") ? 5_000 : REQUEST_TIMEOUT_MILLISECONDS),
      headers: {
        Authorization: `Basic ${Buffer.from(`${input.credentials.username}:${input.credentials.password}`, "utf8").toString("base64")}`,
        ...(input.generationId === undefined ? {} : { "x-dim-generation-id": input.generationId }),
        ...(body === undefined ? {} : { "Content-Length": String(body.length), "Content-Type": "application/json" })
      }
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          incoming.destroy(new ReviewClientError("review API response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }));
      incoming.on("error", reject);
    });
    request.on("error", (cause) => reject(new ReviewClientError("review authority is unavailable or timed out; inspect current state before retrying", { cause })));
    request.end(body);
  });
  if (response.status < 200 || response.status > 299) {
    const guidance = response.status === 409 ? "refresh the current source, policy and review before retrying"
      : response.status === 401 || response.status === 403 ? "check the selected role and generation"
      : "check Git authority availability and proof/admission load";
    throw new ReviewClientError(`review API returned HTTP ${response.status}; ${guidance}`);
  }
  return response.body;
}

export class ReviewClientError extends Error {
  readonly name = "ReviewClientError";
}
