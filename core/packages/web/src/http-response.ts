import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 16 * 1024;
const CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export type JsonResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new BodyError("JSON required");
  const declared = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(declared) || declared > MAX_BODY_BYTES) throw new BodyError("body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyError("body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(response: ServerResponse, output: JsonResponse): void {
  if (response.writableEnded) return;
  response.writeHead(output.status, securityHeaders({ "Content-Type": "application/json; charset=utf-8", ...output.headers }));
  response.end(`${JSON.stringify(output.body)}\n`);
}

export function sendEmpty(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.writableEnded) return;
  response.writeHead(status, securityHeaders(headers));
  response.end();
}

function securityHeaders(extra: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra
  };
}

export class HttpResponseError extends Error {
  readonly name = "HttpResponseError";
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage);
  }
}

export class BodyError extends Error {
  readonly name = "BodyError";
}
