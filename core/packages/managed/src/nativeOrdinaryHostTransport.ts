import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";

const maximumResponseBytes = 64 * 1024;

export function createNodeNativeOrdinaryHostHttpClient(): NativeGitAdmissionHttpClient {
  return {
    request(input) {
      const url = new URL(input.path, input.endpoint);
      return nodeRequest(url, input);
    }
  };
}

function nodeRequest(
  url: URL,
  input: NativeGitAdmissionHttpRequest
): Promise<NativeGitAdmissionHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(url, {
      method: input.method,
      signal: input.signal,
      headers: {
        Authorization: input.authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": String(body.length)
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximumResponseBytes) {
          response.destroy(new NativeOrdinaryHostTransportError("native ordinary response exceeds limit"));
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

class NativeOrdinaryHostTransportError extends Error {
  readonly name = "NativeOrdinaryHostTransportError";
}
