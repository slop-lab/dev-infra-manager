import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

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
      headers: {
        Authorization: `Basic ${Buffer.from(`${input.credentials.username}:${input.credentials.password}`, "utf8").toString("base64")}`,
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
    request.setTimeout(REQUEST_TIMEOUT_MILLISECONDS, () => request.destroy(new ReviewClientError("review API request timed out")));
    request.on("error", reject);
    request.end(body);
  });
  if (response.status < 200 || response.status > 299) {
    throw new ReviewClientError(`review API returned HTTP ${response.status}: ${response.body.trim()}`);
  }
  return response.body;
}

export class ReviewClientError extends Error {
  readonly name = "ReviewClientError";
}
