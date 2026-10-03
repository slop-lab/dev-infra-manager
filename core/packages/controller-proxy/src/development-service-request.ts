import http from "node:http";
import path from "node:path";
import { isPort } from "./development-service-state.js";

const MAX_RESPONSE_BYTES = 65_536;

export type DevelopmentUrlRequestOptions = {
  readonly ingress: string;
  readonly containers: readonly string[];
  readonly targetPort: number;
  readonly controllerSocket: string;
  readonly controllerToken: string;
};

export async function requestDevelopmentUrl(options: DevelopmentUrlRequestOptions): Promise<unknown> {
  validateOptions(options);
  const encoded = JSON.stringify({
    ingress: options.ingress,
    target: {
      containers: options.containers,
      protocol: "http",
      port: options.targetPort
    }
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: options.controllerSocket,
      method: "POST",
      path: "/api/urls",
      headers: {
        authorization: `Bearer ${options.controllerToken}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(encoded))
      },
      signal: AbortSignal.timeout(5_000)
    }, async (response) => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            throw new DevelopmentUrlRequestError("external URL response is too large");
          }
          chunks.push(buffer);
        }
        if (response.statusCode !== 200 && response.statusCode !== 201) {
          throw new DevelopmentUrlRequestError(`external URL registration failed (${response.statusCode ?? 500})`);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

function validateOptions(options: DevelopmentUrlRequestOptions): void {
  if (!options.ingress) throw new DevelopmentUrlRequestError("external URL ingress is required");
  if (options.containers.length < 1 || options.containers.length > 2
    || options.containers.some((container) => container.length === 0)) {
    throw new DevelopmentUrlRequestError("nested container path requires one or two non-empty names");
  }
  if (!isPort(options.targetPort)) {
    throw new DevelopmentUrlRequestError("service port must be an integer between 1 and 65535");
  }
  if (!path.isAbsolute(options.controllerSocket)) {
    throw new DevelopmentUrlRequestError("workspace controller socket must be an absolute path");
  }
}

export class DevelopmentUrlRequestError extends Error {
  readonly name = "DevelopmentUrlRequestError";
}
