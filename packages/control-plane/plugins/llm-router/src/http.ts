import type { IncomingMessage, ServerResponse } from "node:http";
export class RequestError extends Error { constructor(readonly status: number, message: string, readonly category = "invalid_request") { super(message); } }
export function send(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
export async function body(request: IncomingMessage, maximum: number | null): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (maximum !== null && size > maximum) throw new RequestError(413, "request body exceeds configured bound"); chunks.push(bytes); } return Buffer.concat(chunks);
}
