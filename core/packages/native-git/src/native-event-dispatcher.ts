import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { NativeGitServiceConfig } from "./config.js";
import { createReviewStore, type ReviewOutboxEntry } from "./review-store.js";

const maximumResponseBytes = 64 * 1024;

const acknowledgementResponseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  accepted: z.literal(true)
}).strict().readonly();

export type NativeEventHttpRequest = {
  readonly endpoint: string;
  readonly authorization: string;
  readonly body: string;
  readonly signal: AbortSignal;
};

export type NativeEventHttpResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export interface NativeEventHttpClient {
  request(input: NativeEventHttpRequest): Promise<NativeEventHttpResponse>;
}

export type NativeEventDispatcherOptions = {
  readonly config: NativeGitServiceConfig;
  readonly httpClient: NativeEventHttpClient;
  readonly minimumRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
  readonly idleMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
};

export type NativeEventDispatcher = {
  start(): void;
  wake(): void;
  close(): Promise<void>;
};

export function createNativeEventDispatcher(options: NativeEventDispatcherOptions): NativeEventDispatcher {
  const dependency = options.config.ordinaryCi;
  if (dependency === undefined) throw new NativeEventDeliveryError("ordinary CI dependency is required for event delivery");
  const controller = new AbortController();
  const minimumRetry = options.minimumRetryMilliseconds ?? 250;
  const maximumRetry = options.maximumRetryMilliseconds ?? 30_000;
  const idle = options.idleMilliseconds ?? 1_000;
  const requestTimeout = options.requestTimeoutMilliseconds ?? 10_000;
  if (!validDelay(minimumRetry) || !validDelay(maximumRetry) || !validDelay(idle)
    || !validDelay(requestTimeout) || minimumRetry > maximumRetry) {
    throw new NativeEventDeliveryError("native event dispatcher timing bounds are invalid");
  }
  let task: Promise<void> | undefined;
  let wakeCurrent: (() => void) | undefined;
  const endpoint = dependency.webhook.endpoint;
  const authorization = `Basic ${Buffer.from(
    `${dependency.webhook.username}:${dependency.webhook.password}`,
    "utf8"
  ).toString("base64")}`;

  return {
    start() {
      task ??= run();
    },
    wake() {
      wakeCurrent?.();
    },
    async close() {
      controller.abort();
      wakeCurrent?.();
      await task;
    }
  };

  async function run(): Promise<void> {
    let retryMilliseconds = minimumRetry;
    while (!controller.signal.aborted) {
      try {
        const pending = await oldestPending(options.config);
        if (pending === undefined) {
          await wait(idle);
          continue;
        }
        await deliver({
          httpClient: options.httpClient,
          endpoint,
          authorization,
          entry: pending.entry,
          shutdownSignal: controller.signal,
          timeoutMilliseconds: requestTimeout
        });
        await pending.store.acknowledgeOutboxEvent(pending.entry);
        retryMilliseconds = minimumRetry;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!(error instanceof Error)) throw error;
        await wait(retryMilliseconds);
        retryMilliseconds = Math.min(maximumRetry, retryMilliseconds * 2);
      }
    }
  }

  async function wait(milliseconds: number): Promise<void> {
    if (controller.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const complete = (): void => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", complete);
        if (wakeCurrent === complete) wakeCurrent = undefined;
        resolve();
      };
      const timer = setTimeout(complete, milliseconds);
      wakeCurrent = complete;
      controller.signal.addEventListener("abort", complete, { once: true });
    });
  }
}

export function createNodeNativeEventHttpClient(originOverride?: string): NativeEventHttpClient {
  return {
    request(input) {
      const url = new URL(originOverride ?? input.endpoint);
      return new Promise((resolve, reject) => {
        const body = Buffer.from(input.body, "utf8");
        const request = httpRequest(url, {
          method: "POST",
          signal: input.signal,
          headers: {
            Authorization: input.authorization,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Content-Length": String(body.length)
          }
        }, (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumResponseBytes) {
              response.destroy(new NativeEventDeliveryError("ordinary CI acknowledgement exceeded the size limit"));
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
        request.end(body);
      });
    }
  };
}

type PendingEvent = {
  readonly entry: ReviewOutboxEntry;
  readonly store: ReturnType<typeof createReviewStore>;
  readonly repositoryKey: string;
};

async function oldestPending(config: NativeGitServiceConfig): Promise<PendingEvent | undefined> {
  const candidates = await Promise.all(config.repositories.map(async (repository) => {
    const store = createReviewStore(join(config.storageRoot, repository.projectId, `${repository.repositoryId}.git`));
    const entry = (await store.readOutbox(1))[0];
    return entry === undefined ? undefined : {
      entry,
      store,
      repositoryKey: `${repository.projectId}/${repository.repositoryId}`
    };
  }));
  return candidates
    .filter((candidate): candidate is PendingEvent => candidate !== undefined)
    .sort((left, right) => left.entry.createdAt.localeCompare(right.entry.createdAt)
      || left.repositoryKey.localeCompare(right.repositoryKey)
      || left.entry.event.jobName.localeCompare(right.entry.event.jobName)
      || left.entry.event.eventId.localeCompare(right.entry.event.eventId))[0];
}

type DeliveryRequest = {
  readonly httpClient: NativeEventHttpClient;
  readonly endpoint: string;
  readonly authorization: string;
  readonly entry: ReviewOutboxEntry;
  readonly shutdownSignal: AbortSignal;
  readonly timeoutMilliseconds: number;
};

async function deliver(request: DeliveryRequest): Promise<void> {
  if (Buffer.byteLength(request.entry.bytes, "utf8") > maximumResponseBytes) {
    throw new NativeEventDeliveryError("native event exceeded the request size limit");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timeout = setTimeout(abort, request.timeoutMilliseconds);
  request.shutdownSignal.addEventListener("abort", abort, { once: true });
  let response: NativeEventHttpResponse;
  try {
    response = await request.httpClient.request({
      endpoint: request.endpoint,
      authorization: request.authorization,
      body: request.entry.bytes,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    request.shutdownSignal.removeEventListener("abort", abort);
  }
  if (response.statusCode !== 202 || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new NativeEventDeliveryError("ordinary CI returned an invalid event acknowledgement");
  }
  let input: unknown;
  try {
    input = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeEventDeliveryError("ordinary CI returned malformed JSON", { cause: error });
    throw error;
  }
  const parsed = acknowledgementResponseSchema.safeParse(input);
  if (!parsed.success || parsed.data.eventId !== request.entry.event.eventId) {
    throw new NativeEventDeliveryError("ordinary CI returned a mismatched event acknowledgement");
  }
}

function validDelay(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 30_000;
}

export class NativeEventDeliveryError extends Error {
  readonly name = "NativeEventDeliveryError";
}
