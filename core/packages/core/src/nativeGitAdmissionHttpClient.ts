import { request as httpRequest } from "node:http";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";

const maximumResponseBytes = 64 * 1024;

export function createNodeNativeGitAdmissionHttpClient(): NativeGitAdmissionHttpClient {
  return {
    request(input) {
      return nodeRequest(new URL(input.path, input.endpoint), input);
    }
  };
}

function nodeRequest(url: URL, input: NativeGitAdmissionHttpRequest): Promise<NativeGitAdmissionHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const request = httpRequest(url, {
      method: input.method,
      signal: input.signal,
      headers: {
        Authorization: input.authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(body.length) })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximumResponseBytes) {
          response.destroy(new Error("native admission response exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
        cacheControl: response.headers["cache-control"],
        body: Buffer.concat(chunks)
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
