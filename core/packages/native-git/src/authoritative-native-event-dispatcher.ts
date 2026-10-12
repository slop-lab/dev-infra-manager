import { join } from "node:path";
import { z } from "zod";
import {
  acknowledgeAuthoritativeNativeDelivery,
  readPendingAuthoritativeNativeDeliveries,
  supersedeAuthoritativeNativeDelivery,
  type AuthoritativeNativePendingDelivery
} from "./authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import { readNativeProjectRegistrations, type NativeGitBundleState } from "./native-bundle-state.js";
import type { AdmissionVerifierHttpClient, AdmissionVerifierHttpResponse } from "./ordinary-admission-http.js";
import type { ReviewPublicationFaults } from "./review-record-storage.js";

const maximumResponseBytes = 64 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const acknowledgementSchema = z.object({ schemaVersion: z.literal(2), serviceId: z.literal("ordinary-main"),
  serviceGenerationId: digest, generationId: digest, eligibilityGeneration: uuidV4,
  eligibilityExpiresAt: z.number().int().positive(), eventId: digest, recorded: z.literal(true) }).strict().readonly();

export type AuthoritativeNativeEventDispatcher = {
  readonly start: () => void;
  readonly wake: () => void;
  readonly close: () => Promise<void>;
  readonly healthy: () => boolean;
};

export type AuthoritativeNativeEventDispatcherOptions = {
  readonly webhook: { readonly endpoint: string; readonly username: string; readonly password: string };
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
  readonly generationId: string;
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  readonly deliveryFaults?: ReviewPublicationFaults;
  readonly minimumRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
  readonly idleMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
};

export async function createAuthoritativeNativeEventDispatcher(
  options: AuthoritativeNativeEventDispatcherOptions
): Promise<AuthoritativeNativeEventDispatcher> {
  const timing = { minimum: options.minimumRetryMilliseconds ?? 250,
    maximum: options.maximumRetryMilliseconds ?? 30_000, idle: options.idleMilliseconds ?? 1_000,
    request: options.requestTimeoutMilliseconds ?? 5_000 };
  const binding = authoritativeNativeDeliveryBinding("ordinary-main", options.webhook.endpoint);
  if (Object.values(timing).some((value) => !Number.isInteger(value) || value < 1 || value > 30_000)
    || timing.minimum > timing.maximum) {
    throw new AuthoritativeNativeEventDeliveryError("authoritative native delivery timing is invalid");
  }
  await options.serialize(() => pendingDelivery(options, binding));
  const shutdown = new AbortController();
  let task: Promise<void> | undefined;
  let wakeCurrent: (() => void) | undefined;
  let failure: Error | undefined;
  let persistenceUnavailable = false;
  return {
    start() {
      task ??= run().catch((error: unknown) => {
        failure = error instanceof Error ? error : new AuthoritativeNativeEventDeliveryError("delivery failed");
      });
    },
    wake() { wakeCurrent?.(); },
    healthy() { return failure === undefined && !persistenceUnavailable; },
    async close() {
      shutdown.abort();
      wakeCurrent?.();
      await task;
      if (failure !== undefined) throw failure;
    }
  };

  async function run(): Promise<void> {
    let retry = timing.minimum;
    while (!shutdown.signal.aborted) {
      try {
        const pending = await options.serialize(() => pendingDelivery(options, binding));
        if (pending === undefined) {
          await wait(timing.idle);
          continue;
        }
        let acknowledgement;
        try { acknowledgement = await deliver(options, pending, {
          shutdown: shutdown.signal, timeoutMilliseconds: timing.request
        }); } catch (error) {
          if (!(error instanceof AuthoritativeNativeEventRejectedError)) throw error;
          await options.serialize(() => supersedeAuthoritativeNativeDelivery(pending.repository,
            pending.delivery, binding, error.statusCode, timing.minimum, options.deliveryFaults));
          retry = timing.minimum;
          continue;
        }
        await options.serialize(() => acknowledgeAuthoritativeNativeDelivery(
          pending.repository, pending.delivery, acknowledgement, binding, options.deliveryFaults
        ));
        persistenceUnavailable = false;
        retry = timing.minimum;
      } catch (error) {
        if (shutdown.signal.aborted) return;
        if (!(error instanceof AuthoritativeNativeEventDeliveryError)
          && !transientFilesystemError(error)) throw error;
        if (transientFilesystemError(error)) persistenceUnavailable = true;
        await wait(retry);
        retry = Math.min(timing.maximum, retry * 2);
      }
    }
  }

  async function wait(milliseconds: number): Promise<void> {
    if (shutdown.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const complete = (): void => {
        clearTimeout(timer);
        shutdown.signal.removeEventListener("abort", complete);
        if (wakeCurrent === complete) wakeCurrent = undefined;
        resolve();
      };
      const timer = setTimeout(complete, milliseconds);
      wakeCurrent = complete;
      shutdown.signal.addEventListener("abort", complete, { once: true });
    });
  }
}

function transientFilesystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ENOSPC", "EIO", "EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EACCES"].includes(error.code);
}

async function pendingDelivery(options: AuthoritativeNativeEventDispatcherOptions,
  binding: ReturnType<typeof authoritativeNativeDeliveryBinding>): Promise<Pending | undefined> {
  const candidates = await Promise.all(readNativeProjectRegistrations(options.state).map(async (registration) => {
    const repository = join(options.stateDirectory, registration.projectId, `${registration.rootRepositoryId}.git`);
    const delivery = (await readPendingAuthoritativeNativeDeliveries(repository, 1, binding))[0];
    return delivery === undefined ? undefined : { repository, delivery };
  }));
  return candidates.filter((candidate): candidate is Pending => candidate !== undefined)
    .sort((left, right) => left.delivery.createdAt.localeCompare(right.delivery.createdAt)
      || left.delivery.event.projectId.localeCompare(right.delivery.event.projectId)
      || left.delivery.event.reviewId.localeCompare(right.delivery.event.reviewId)
      || left.delivery.event.jobName.localeCompare(right.delivery.event.jobName)
      || left.delivery.event.eventId.localeCompare(right.delivery.event.eventId))[0];
}

async function deliver(
  options: AuthoritativeNativeEventDispatcherOptions,
  pending: Pending,
  context: DeliveryContext
): Promise<{ readonly serviceId: string; readonly serviceGenerationId: string;
  readonly eligibilityGeneration: string; readonly eligibilityExpiresAt: number }> {
  const signal = AbortSignal.any([context.shutdown, AbortSignal.timeout(context.timeoutMilliseconds)]);
  const event = pending.delivery.event;
  const receipt = { schemaVersion: 1, generationId: options.generationId, event } as const;
  const acknowledgementResult = acknowledgementSchema.safeParse(await requestJson(options.httpClient, {
    endpoint: options.webhook.endpoint, method: "POST", path: "/v1/native-root-ci-events",
    authorization: authorization(options.webhook), body: JSON.stringify(receipt), signal
  }, 202));
  if (!acknowledgementResult.success) {
    throw new AuthoritativeNativeEventDeliveryError("ordinary receipt acknowledgement is malformed");
  }
  const acknowledged = acknowledgementResult.data;
  if (acknowledged.generationId !== options.generationId
    || acknowledged.serviceGenerationId !== options.generationId || acknowledged.eventId !== event.eventId) {
    throw new AuthoritativeNativeEventDeliveryError("ordinary receipt acknowledgement does not match delivery");
  }
  return { serviceId: acknowledged.serviceId, serviceGenerationId: acknowledged.serviceGenerationId,
    eligibilityGeneration: acknowledged.eligibilityGeneration,
    eligibilityExpiresAt: acknowledged.eligibilityExpiresAt };
}

async function requestJson(
  client: AdmissionVerifierHttpClient,
  input: Parameters<AdmissionVerifierHttpClient["request"]>[0],
  expectedStatus: 202
): Promise<unknown> {
  let response: AdmissionVerifierHttpResponse;
  try { response = await client.request(input); }
  catch (error) { throw new AuthoritativeNativeEventDeliveryError("ordinary delivery request failed", { cause: error }); }
  if ((response.statusCode === 404 || response.statusCode === 409) && response.contentType === "application/json"
    && response.cacheControl === "no-store" && response.body.length <= maximumResponseBytes) {
    throw new AuthoritativeNativeEventRejectedError(response.statusCode);
  }
  if (response.statusCode !== expectedStatus || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new AuthoritativeNativeEventDeliveryError("ordinary delivery response is invalid");
  }
  try { return JSON.parse(response.body.toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new AuthoritativeNativeEventDeliveryError("ordinary delivery response is malformed", { cause: error });
    }
    throw error;
  }
}

function authorization(credential: { readonly username: string; readonly password: string }): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}

type Pending = { readonly repository: string; readonly delivery: AuthoritativeNativePendingDelivery };
type DeliveryContext = { readonly shutdown: AbortSignal; readonly timeoutMilliseconds: number };
export class AuthoritativeNativeEventDeliveryError extends Error {
  readonly name: string = "AuthoritativeNativeEventDeliveryError";
}
class AuthoritativeNativeEventRejectedError extends AuthoritativeNativeEventDeliveryError {
  readonly name = "AuthoritativeNativeEventRejectedError";
  constructor(readonly statusCode: 404 | 409) { super("ordinary delivery event is stale"); }
}
