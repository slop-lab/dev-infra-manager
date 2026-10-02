import { request as httpRequest } from "node:http";
import { lifecycleOptions, UserError } from "@slop-lab/dim-core";
import {
  createAdminStreamProgress,
  type AdminStreamOptions,
  type CliProgress,
  type ProgressStream
} from "./cli-progress.js";
import { ensureManagedController } from "./managed-controller.js";
import { adminErrorDetail, unixHttpRequest } from "./controller-transport.js";

export async function adminStreamCall<T = unknown>(
  operation: string,
  body: Record<string, unknown> = {},
  options: AdminStreamOptions = {}
): Promise<T> {
  const lifecycle = lifecycleOptions();
  await ensureManagedController(lifecycle);
  const sessionInput = options.terminal
    ? {
        ...body,
        terminal: {
          columns: process.stdout.columns || 80,
          rows: process.stdout.rows || 24
        }
      }
    : body;
  const created = await unixHttpRequest(lifecycle.adminControllerSocketPath, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ operation, input: sessionInput })
  });
  if (created.status !== 202) throw new UserError(adminErrorDetail(created.body) || `could not start ${operation}`);
  const id = (JSON.parse(created.body) as { id?: unknown }).id;
  if (typeof id !== "string") throw new UserError("controller returned an invalid command session");
  const progress = createAdminStreamProgress(operation, options);

  let inputHandler: ((chunk: Buffer) => void) | undefined;
  let inputEndHandler: (() => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  let inputQueue = Promise.resolve<void>(undefined);
  let cancellationRequest: Promise<void> | undefined;
  let acceptingInput = true;
  let failed = false;
  let failureReason: unknown;
  let rejectFailure: (reason?: unknown) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const inputAbort = new AbortController();
  const sessionAbort = new AbortController();
  const recordFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    failureReason = error;
    acceptingInput = false;
    rejectFailure(error);
    inputAbort.abort(error);
    sessionAbort.abort(error);
  };
  const requestCancellation = (): Promise<void> => {
    if (cancellationRequest) return cancellationRequest;
    cancellationRequest = (async () => {
      const response = await unixHttpRequest(
        lifecycle.adminControllerSocketPath,
        `/v1/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (response.status < 200 || response.status >= 300) {
        throw new UserError(adminErrorDetail(response.body) || `command session cancellation failed (${response.status})`);
      }
      sessionAbort.abort(new UserError(`command session '${id}' cancelled`));
    })().catch(recordFailure);
    return cancellationRequest;
  };
  const enqueueInput = (payload: Record<string, unknown>): void => {
    if (!acceptingInput) return;
    inputQueue = inputQueue.then(async () => {
      if (failed) return;
      try {
        const response = await unixHttpRequest(
          lifecycle.adminControllerSocketPath,
          `/v1/sessions/${encodeURIComponent(id)}/input`,
          { method: "POST", body: JSON.stringify(payload), signal: inputAbort.signal }
        );
        if (response.status < 200 || response.status >= 300) {
          throw new UserError(adminErrorDetail(response.body) || `command session input failed (${response.status})`);
        }
      } catch (error) {
        recordFailure(error);
        void requestCancellation();
      }
    });
  };
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (options.stdin) {
    if (options.terminal && process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    inputHandler = (chunk: Buffer) => {
      enqueueInput({ data: Buffer.from(chunk).toString("base64") });
    };
    inputEndHandler = () => {
      enqueueInput({ data: "", end: true });
    };
    process.stdin.on("data", inputHandler);
    process.stdin.once("end", inputEndHandler);
  }
  if (options.terminal) {
    resizeHandler = () => {
      enqueueInput({
        resize: {
          columns: process.stdout.columns || 80,
          rows: process.stdout.rows || 24
        }
      });
    };
    process.on("SIGWINCH", resizeHandler);
  }
  const cancel = () => {
    progress.stop();
    void requestCancellation();
  };
  process.once("SIGINT", cancel);
  try {
    try {
      const result = await Promise.race([
        readAdminSession<T>(lifecycle.adminControllerSocketPath, id, { progress, signal: sessionAbort.signal }),
        failure
      ]);
      acceptingInput = false;
      await inputQueue;
      if (failed) throw failureReason;
      return result;
    } catch (error) {
      recordFailure(error);
      await inputQueue;
      throw failureReason;
    }
  } finally {
    acceptingInput = false;
    inputAbort.abort();
    sessionAbort.abort();
    await inputQueue;
    if (cancellationRequest) await cancellationRequest;
    progress.stop();
    process.removeListener("SIGINT", cancel);
    if (inputHandler) process.stdin.removeListener("data", inputHandler);
    if (inputEndHandler) process.stdin.removeListener("end", inputEndHandler);
    if (resizeHandler) process.removeListener("SIGWINCH", resizeHandler);
    if (options.terminal && process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    if (options.stdin) process.stdin.pause();
  }
}

interface AdminSessionReadOptions {
  readonly progress?: CliProgress;
  readonly stdout?: ProgressStream;
  readonly stderr?: ProgressStream;
  readonly signal?: AbortSignal;
}

const inactiveSessionProgress: CliProgress = {
  activity() {},
  update() {},
  stop() {}
};

export function readAdminSession<T = unknown>(
  socketPath: string,
  id: string,
  options: AdminSessionReadOptions = {}
): Promise<T> {
  const progress = options.progress ?? inactiveSessionProgress;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpRequest> | undefined;
    const stopAbort = (): void => options.signal?.removeEventListener("abort", abort);
    const succeed = (result: T): void => {
      if (settled) return;
      settled = true;
      stopAbort();
      progress.stop();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stopAbort();
      progress.stop();
      reject(error);
    };
    const abort = (): void => {
      const error = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new UserError(`command session '${id}' cancelled`);
      fail(error);
      request?.destroy(error);
    };
    request = httpRequest({
      socketPath,
      path: `/v1/sessions/${encodeURIComponent(id)}/events`,
      method: "GET",
      headers: { accept: "text/event-stream" }
    }, (response) => {
      response.on("aborted", () => fail(new UserError(`command session '${id}' disconnected`)));
      response.on("error", fail);
      if ((response.statusCode ?? 500) !== 200) {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => fail(new UserError(adminErrorDetail(Buffer.concat(chunks).toString("utf8")))));
        return;
      }
      let pending = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        try {
          pending += chunk;
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const event = JSON.parse(data) as {
              type: string; data?: string; encoding?: string; result?: T; error?: string; stage?: string
            };
            if ((event.type === "stdout" || event.type === "stderr") && event.data) {
              if (event.encoding !== "base64") {
                throw new UserError(`command session '${id}' returned invalid stream encoding`);
              }
              const output = Buffer.from(event.data, "base64");
              progress.activity();
              if (event.type === "stdout") stdout.write(output);
              else stderr.write(output);
            }
            else if (event.type === "progress" && typeof event.stage === "string") progress.update(event.stage);
            else if (event.type === "result") succeed(event.result as T);
            else if (event.type === "error") fail(new UserError(event.error ?? `${id} failed`));
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          fail(error);
          response.destroy();
        }
      });
      response.on("end", () => fail(new UserError(`command session '${id}' ended without a result`)));
    });
    request.on("error", fail);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (settled) return;
    request.end();
  });
}
