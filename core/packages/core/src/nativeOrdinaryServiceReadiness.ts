import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";

const maximumResponseBytes = 4 * 1024;
const timeoutMilliseconds = 2_000;

export type NativeOrdinaryServiceReadinessOptions = {
  readonly tokenPath: string;
  readonly origin: string;
};

export async function checkNativeOrdinaryServiceReadiness(
  options: NativeOrdinaryServiceReadinessOptions
): Promise<void> {
  const token = await readReadinessToken(options.tokenPath);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (cause?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new NativeOrdinaryServiceReadinessError("ordinary CI readiness check failed", { cause }));
    };
    const outgoing = request(new URL("/readyz", `${options.origin}/`), {
      method: "GET",
      agent: false,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumResponseBytes) {
          incoming.destroy();
          fail();
        } else chunks.push(chunk);
      });
      incoming.once("error", fail);
      incoming.once("end", () => {
        if (settled) return;
        const body = Buffer.concat(chunks).toString("utf8");
        if (incoming.statusCode !== 200 || incoming.headers["content-type"] !== "application/json"
          || incoming.headers["cache-control"] !== "no-store" || !isExactReadyBody(body)) {
          fail();
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve();
      });
    });
    const deadline = setTimeout(() => {
      outgoing.destroy();
      fail();
    }, timeoutMilliseconds);
    outgoing.once("error", fail);
    outgoing.end();
  });
}

async function readReadinessToken(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o444) {
      throw new NativeOrdinaryServiceReadinessError("ordinary CI readiness token path is invalid");
    }
    const value = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]+\n$/.test(value)) {
      throw new NativeOrdinaryServiceReadinessError("ordinary CI readiness token file is invalid");
    }
    return value.slice(0, -1);
  } finally {
    await handle.close();
  }
}

function isExactReadyBody(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 2 && Reflect.get(value, "status") === "ready"
      && Reflect.get(value, "schemaVersion") === 1;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export class NativeOrdinaryServiceReadinessError extends Error {
  readonly name = "NativeOrdinaryServiceReadinessError";
}
