import { request } from "node:http";

const responseLimit = 4 * 1024;

/** Activation includes repository recovery and proposal review reconciliation. */
export async function activateNativeGitGeneration(input: {
  readonly origin: string;
  readonly generationId: string;
  readonly token: string;
  readonly timeoutMilliseconds: number;
}): Promise<void> {
  const body = JSON.stringify({ schemaVersion: 1, generationId: input.generationId });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new NativeGitActivationError("native Git activation failed"));
    };
    const outgoing = request(new URL("/v1/activation", input.origin), {
      method: "POST", agent: false,
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > responseLimit) { incoming.destroy(); fail(); }
        else chunks.push(chunk);
      });
      incoming.once("error", fail);
      incoming.once("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (incoming.statusCode === 200 && incoming.headers["content-type"] === "application/json"
          && incoming.headers["cache-control"] === "no-store"
          && exactActivationResponse(Buffer.concat(chunks).toString("utf8"), input.generationId)) resolve();
        else reject(new NativeGitActivationError("native Git activation failed"));
      });
    });
    const deadline = setTimeout(() => { outgoing.destroy(); fail(); }, input.timeoutMilliseconds);
    outgoing.once("error", fail);
    outgoing.end(body);
  });
}

function exactActivationResponse(body: string, generationId: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 3 && Reflect.get(value, "schemaVersion") === 1
      && Reflect.get(value, "generationId") === generationId && Reflect.get(value, "activated") === true;
  } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
}
export class NativeGitActivationError extends Error { readonly name = "NativeGitActivationError"; }
