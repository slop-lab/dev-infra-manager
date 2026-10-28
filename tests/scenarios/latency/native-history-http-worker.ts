import { request } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

type WorkerInput = {
  readonly endpoint: string;
  readonly authorization: string;
  readonly cadenceMilliseconds: number;
  readonly deadlineMilliseconds: number;
};

class NativeHistoryHttpWorkerError extends Error {
  readonly name = "NativeHistoryHttpWorkerError";
}

const port = requireParentPort();
const input = parseInput(workerData);
let stopping = false;
let active: AbortController | undefined;

port.on("message", (message: unknown) => {
  if (message !== "stop") return;
  stopping = true;
  active?.abort();
  if (active === undefined) port.postMessage({ kind: "stopped" });
});
port.postMessage({ kind: "ready" });
void sample();

async function sample(): Promise<void> {
  if (stopping) {
    port.postMessage({ kind: "stopped" });
    return;
  }
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), input.deadlineMilliseconds);
  const started = performance.now();
  try {
    const statusCode = await identityRequest(controller.signal);
    port.postMessage({ kind: "sample", milliseconds: performance.now() - started, statusCode });
  } catch (error) {
    if (!stopping) port.postMessage({ kind: "failure", message: boundedError(error) });
  } finally {
    clearTimeout(timeout);
    active = undefined;
  }
  if (stopping) {
    port.postMessage({ kind: "stopped" });
    return;
  }
  setTimeout(() => void sample(), input.cadenceMilliseconds);
}

function identityRequest(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/operator-workspace-write-issuer-identity", input.endpoint);
    const pending = request(url, {
      method: "GET",
      signal,
      headers: { Authorization: input.authorization, Accept: "application/json" }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      response.destroy();
      resolve(statusCode);
    });
    pending.once("error", reject);
    pending.end();
  });
}

function parseInput(value: unknown): WorkerInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeHistoryHttpWorkerError("identity probe input is invalid");
  }
  const endpoint = Reflect.get(value, "endpoint");
  const authorization = Reflect.get(value, "authorization");
  const cadenceMilliseconds = Reflect.get(value, "cadenceMilliseconds");
  const deadlineMilliseconds = Reflect.get(value, "deadlineMilliseconds");
  if (typeof endpoint !== "string" || typeof authorization !== "string"
    || typeof cadenceMilliseconds !== "number" || typeof deadlineMilliseconds !== "number") {
    throw new NativeHistoryHttpWorkerError("identity probe input is invalid");
  }
  return { endpoint, authorization, cadenceMilliseconds, deadlineMilliseconds };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 200);
}

function requireParentPort(): NonNullable<typeof parentPort> {
  if (parentPort === null) throw new NativeHistoryHttpWorkerError("identity probe requires a parent port");
  return parentPort;
}
