import type { IncomingMessage } from "node:http";
import { UserError } from "./errors.js";

export async function bufferControllerRequestBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new UserError("request content-length is invalid");
    if (length > limit) throw new UserError("request body is too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new UserError("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseControllerJsonBody(body: Buffer, limit: number): unknown {
  if (body.length > limit) throw new UserError("request body is too large");
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new UserError("request body must be valid JSON");
  }
}
