import { request as httpRequest } from "node:http";

const maximumResponseBytes = 64 * 1024;

export type AdmissionVerifierHttpRequest = {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type AdmissionVerifierHttpResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export interface AdmissionVerifierHttpClient {
  request(input: AdmissionVerifierHttpRequest): Promise<AdmissionVerifierHttpResponse>;
}

export function createNodeAdmissionVerifierHttpClient(originOverride?: string): AdmissionVerifierHttpClient {
  return {
    request(input) {
      const origin = originOverride ?? input.endpoint;
      return nodeRequest(new URL(input.path, origin), input);
    }
  };
}

function nodeRequest(url: URL, input: AdmissionVerifierHttpRequest): Promise<AdmissionVerifierHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const request = httpRequest(url, {
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
          response.destroy(new OrdinaryAdmissionVerifierError("ordinary CI response exceeded the size limit"));
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

export class OrdinaryAdmissionVerifierError extends Error {
  readonly name = "OrdinaryAdmissionVerifierError";
}
