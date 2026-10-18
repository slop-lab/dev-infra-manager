import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
export type NativeGitAdmissionHttpRequest = {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: string;
  readonly generationId?: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type NativeGitAdmissionHttpResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export interface NativeGitAdmissionHttpClient {
  request(input: NativeGitAdmissionHttpRequest): Promise<NativeGitAdmissionHttpResponse>;
}



const maximumResponseBytes = 512 * 1024;

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
    const sendRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = sendRequest(url, {
      method: input.method,
      signal: input.signal,
      headers: {
        Authorization: input.authorization,
        Accept: "application/json",
        ...(input.generationId === undefined ? {} : { "X-Dim-Generation-Id": input.generationId }),
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
