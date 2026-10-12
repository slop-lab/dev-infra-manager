import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { acknowledgeAuthoritativeNativeQemuDelivery,
  readPendingAuthoritativeNativeQemuDeliveries,
  supersedeAuthoritativeNativeQemuDelivery,
  type AuthoritativeNativeQemuPendingDelivery } from "./authoritative-native-qemu-delivery-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { authoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import type { AdmissionVerifierHttpClient, AdmissionVerifierHttpResponse } from "./ordinary-admission-http.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";
import type { ReviewPublicationFaults } from "./review-record-storage.js";

const maximumResponseBytes = 64 * 1024;
const acknowledgementSchema = z.object({ schemaVersion: z.literal(2), serviceId: z.literal("qemu-main"),
  serviceGenerationId: z.string().uuid(), eventId: z.string(), eligibilityGeneration: z.string().uuid(),
  eligibilityExpiresAt: z.number().int().positive(), recorded: z.literal(true) }).strict().readonly();

export type AuthoritativeNativeQemuEventDispatcher = {
  readonly start: () => void; readonly wake: () => void; readonly close: () => Promise<void>;
  readonly healthy: () => boolean;
};
export type AuthoritativeNativeQemuEventDispatcherOptions = {
  readonly dependency: NonNullable<NativeGitBundleConfig["qemuCi"]>;
  readonly state: NativeGitBundleState; readonly stateDirectory: string;
  readonly httpClient: AdmissionVerifierHttpClient; readonly deliveryFaults?: ReviewPublicationFaults;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  readonly minimumRetryMilliseconds?: number; readonly maximumRetryMilliseconds?: number;
  readonly idleMilliseconds?: number; readonly requestTimeoutMilliseconds?: number;
};

export async function createAuthoritativeNativeQemuEventDispatcher(
  options: AuthoritativeNativeQemuEventDispatcherOptions
): Promise<AuthoritativeNativeQemuEventDispatcher> {
  const timing = { minimum: options.minimumRetryMilliseconds ?? 250,
    maximum: options.maximumRetryMilliseconds ?? 30_000, idle: options.idleMilliseconds ?? 1_000,
    request: options.requestTimeoutMilliseconds ?? 5_000 };
  const binding = authoritativeNativeDeliveryBinding(options.dependency.serviceId, options.dependency.endpoint);
  if (Object.values(timing).some((value) => !Number.isInteger(value) || value < 1 || value > 30_000)
    || timing.minimum > timing.maximum) throw new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery timing is invalid");
  await options.serialize(() => pendingDelivery(options, binding));
  const shutdown = new AbortController();
  let task: Promise<void> | undefined;
  let wakeCurrent: (() => void) | undefined;
  let failure: Error | undefined;
  let persistenceUnavailable = false;
  return { start() { task ??= run().catch((error: unknown) => {
      failure = error instanceof Error ? error : new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery failed");
    }); },
    wake() { wakeCurrent?.(); }, healthy() { return failure === undefined && !persistenceUnavailable; },
    async close() { shutdown.abort(); wakeCurrent?.(); await task; if (failure !== undefined) throw failure; } };

  async function run(): Promise<void> {
    let retry = timing.minimum;
    while (!shutdown.signal.aborted) {
      try {
        const pending = await options.serialize(() => pendingDelivery(options, binding));
        if (pending === undefined) { await wait(timing.idle); continue; }
        let acknowledgement;
        try { acknowledgement = await deliver(options, pending, shutdown.signal, timing.request); }
        catch (error) {
          if (!(error instanceof AuthoritativeNativeQemuEventRejectedError)) throw error;
          await options.serialize(() => supersedeAuthoritativeNativeQemuDelivery(pending.repository,
            pending.delivery, binding, error.statusCode, timing.minimum, options.deliveryFaults));
          retry = timing.minimum;
          continue;
        }
        await options.serialize(() => acknowledgeAuthoritativeNativeQemuDelivery(
          pending.repository, pending.delivery, acknowledgement, binding, options.deliveryFaults
        ));
        persistenceUnavailable = false; retry = timing.minimum;
      } catch (error) {
        if (shutdown.signal.aborted) return;
        if (!(error instanceof AuthoritativeNativeQemuEventDeliveryError) && !transientFilesystemError(error)) throw error;
        if (transientFilesystemError(error)) persistenceUnavailable = true;
        await wait(retry); retry = Math.min(timing.maximum, retry * 2);
      }
    }
  }
  async function wait(milliseconds: number): Promise<void> {
    if (shutdown.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const complete = (): void => { clearTimeout(timer); shutdown.signal.removeEventListener("abort", complete);
        if (wakeCurrent === complete) wakeCurrent = undefined; resolve(); };
      const timer = setTimeout(complete, milliseconds); wakeCurrent = complete;
      shutdown.signal.addEventListener("abort", complete, { once: true });
    });
  }
}

async function pendingDelivery(options: AuthoritativeNativeQemuEventDispatcherOptions,
  binding: ReturnType<typeof authoritativeNativeDeliveryBinding>): Promise<Pending | undefined> {
  const candidates = await Promise.all(readNativeProjectRegistrations(options.state).map(async (registration) => {
    const repository = join(options.stateDirectory, registration.projectId, `${registration.rootRepositoryId}.git`);
    const delivery = (await readPendingAuthoritativeNativeQemuDeliveries(repository, 1, binding))[0];
    return delivery === undefined ? undefined : { repository, delivery };
  }));
  return candidates.filter((candidate): candidate is Pending => candidate !== undefined)
    .sort((left, right) => left.delivery.createdAt.localeCompare(right.delivery.createdAt)
      || left.delivery.event.eventId.localeCompare(right.delivery.event.eventId))[0];
}

async function deliver(options: AuthoritativeNativeQemuEventDispatcherOptions, pending: Pending,
  shutdown: AbortSignal, timeoutMilliseconds: number): Promise<{ readonly serviceId: string;
    readonly serviceGenerationId: string; readonly eligibilityGeneration: string;
    readonly eligibilityExpiresAt: number }> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(timeoutMilliseconds)]);
  const event = pending.delivery.event;
  const body = JSON.stringify({ schemaVersion: 1, requestId: eventRequestId(event.eventId),
    event });
  const acknowledgementResult = acknowledgementSchema.safeParse(await requestJson(options.httpClient, {
    endpoint: options.dependency.endpoint, method: "POST", path: "/v1/qemu-events",
    authorization: authorization(options.dependency.eventIntake), body, signal
  }, [200, 201]));
  if (!acknowledgementResult.success) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU acknowledgement is malformed");
  }
  const acknowledged = acknowledgementResult.data;
  if (acknowledged.eventId !== event.eventId || acknowledged.recorded !== true) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU acknowledgement does not match delivery");
  }
  return { serviceId: acknowledged.serviceId, serviceGenerationId: acknowledged.serviceGenerationId,
    eligibilityGeneration: acknowledged.eligibilityGeneration,
    eligibilityExpiresAt: acknowledged.eligibilityExpiresAt };
}

async function requestJson(client: AdmissionVerifierHttpClient,
  input: Parameters<AdmissionVerifierHttpClient["request"]>[0], expectedStatus: number | readonly number[]): Promise<unknown> {
  let response: AdmissionVerifierHttpResponse;
  try { response = await client.request(input); }
  catch (error) { throw new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery request failed", { cause: error }); }
  if ((response.statusCode === 404 || response.statusCode === 409) && response.contentType === "application/json"
    && response.cacheControl === "no-store" && response.body.length <= maximumResponseBytes) {
    throw new AuthoritativeNativeQemuEventRejectedError(response.statusCode);
  }
  const statuses = typeof expectedStatus === "number" ? [expectedStatus] : expectedStatus;
  if (!statuses.includes(response.statusCode) || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery response is invalid");
  }
  try { return JSON.parse(response.body.toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) {
      throw new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery response is malformed", { cause: error });
    } throw error; }
}
function authorization(credential: { readonly username: string; readonly password: string }): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}
function eventRequestId(eventId: string): string {
  return `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-4${eventId.slice(13, 16)}-8${eventId.slice(17, 20)}-${eventId.slice(20, 32)}`;
}
function transientFilesystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ENOSPC", "EIO", "EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EACCES"].includes(error.code);
}
type Pending = { readonly repository: string; readonly delivery: AuthoritativeNativeQemuPendingDelivery };
export class AuthoritativeNativeQemuEventDeliveryError extends Error {
  readonly name: string = "AuthoritativeNativeQemuEventDeliveryError";
}
class AuthoritativeNativeQemuEventRejectedError extends AuthoritativeNativeQemuEventDeliveryError {
  readonly name = "AuthoritativeNativeQemuEventRejectedError";
  constructor(readonly statusCode: 404 | 409) { super("QEMU delivery event is stale"); }
}
