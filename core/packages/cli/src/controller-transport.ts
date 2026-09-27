import { request as httpRequest } from "node:http";
import { UserError } from "@slop-lab/dim-core";

export function adminErrorDetail(body: string): string {
  if (!body) return "";
  try {
    const value = JSON.parse(body) as { error?: unknown };
    if (typeof value.error === "string") return value.error;
  } catch {}
  return body.trim();
}

export async function unixHttpRequest(
  socketPath: string,
  pathname: string,
  init: RequestInit,
  token?: string
): Promise<{ status: number; body: string }> {
  const body = typeof init.body === "string" ? init.body : undefined;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest({
      socketPath,
      path: pathname,
      method: init.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => settle(() => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      })));
      response.on("aborted", () => settle(() => reject(new UserError("controller response aborted"))));
      response.on("error", (error) => settle(() => reject(error)));
    });
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = (): void => {
      const error = init.signal?.reason instanceof Error
        ? init.signal.reason
        : new UserError("controller request cancelled");
      settle(() => reject(error));
      request.destroy(error);
    };
    request.on("error", (error) => settle(() => reject(error)));
    if (init.signal?.aborted) {
      abort();
      return;
    }
    init.signal?.addEventListener("abort", abort, { once: true });
    if (body !== undefined) request.write(body);
    request.end();
  });
}
