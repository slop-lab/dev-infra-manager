import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { acknowledgeAuthoritativeNativeQemuDelivery,
  readPendingAuthoritativeNativeQemuDeliveries,
  type AuthoritativeNativeQemuPendingDelivery } from "./authoritative-native-qemu-delivery-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { AdmissionVerifierHttpClient, AdmissionVerifierHttpResponse } from "./ordinary-admission-http.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";
import type { ReviewPublicationFaults } from "./review-record-storage.js";

const maximumResponseBytes = 64 * 1024;
const admissionSchema = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("qemu-main"),
  requestId: z.string().uuid(), admission: z.object({ projectId: z.string(), admissionGeneration: z.string().uuid(),
    leaseExpiresAt: z.number().int(), policyRevision: z.string(), requiredJobSetRevision: z.string(),
    requiredQemuJobs: z.array(z.string()).readonly() }).strict().readonly() }).strict().readonly();
const acknowledgementSchema = z.object({ schemaVersion: z.literal(1), eventId: z.string(),
  recorded: z.literal(true) }).strict().readonly();

export type AuthoritativeNativeQemuEventDispatcher = {
  readonly start: () => void; readonly wake: () => void; readonly close: () => Promise<void>;
  readonly healthy: () => boolean;
};
export type AuthoritativeNativeQemuEventDispatcherOptions = {
  readonly dependency: NonNullable<NativeGitBundleConfig["qemuCi"]>;
  readonly state: NativeGitBundleState; readonly stateDirectory: string;
  readonly httpClient: AdmissionVerifierHttpClient; readonly deliveryFaults?: ReviewPublicationFaults;
  readonly minimumRetryMilliseconds?: number; readonly maximumRetryMilliseconds?: number;
  readonly idleMilliseconds?: number; readonly requestTimeoutMilliseconds?: number;
};

export async function createAuthoritativeNativeQemuEventDispatcher(
  options: AuthoritativeNativeQemuEventDispatcherOptions
): Promise<AuthoritativeNativeQemuEventDispatcher> {
  const timing = { minimum: options.minimumRetryMilliseconds ?? 250,
    maximum: options.maximumRetryMilliseconds ?? 30_000, idle: options.idleMilliseconds ?? 1_000,
    request: options.requestTimeoutMilliseconds ?? 5_000 };
  if (Object.values(timing).some((value) => !Number.isInteger(value) || value < 1 || value > 30_000)
    || timing.minimum > timing.maximum) throw new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery timing is invalid");
  await pendingDelivery(options);
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
        const pending = await pendingDelivery(options);
        if (pending === undefined) { await wait(timing.idle); continue; }
        const admissionGeneration = await deliver(options, pending, shutdown.signal, timing.request);
        await acknowledgeAuthoritativeNativeQemuDelivery(pending.repository, pending.delivery,
          admissionGeneration, options.deliveryFaults);
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

async function pendingDelivery(options: AuthoritativeNativeQemuEventDispatcherOptions): Promise<Pending | undefined> {
  const candidates = await Promise.all(readNativeProjectRegistrations(options.state).map(async (registration) => {
    const repository = join(options.stateDirectory, registration.projectId, `${registration.rootRepositoryId}.git`);
    const delivery = (await readPendingAuthoritativeNativeQemuDeliveries(repository, 1))[0];
    return delivery === undefined ? undefined : { repository, delivery };
  }));
  return candidates.filter((candidate): candidate is Pending => candidate !== undefined)
    .sort((left, right) => left.delivery.createdAt.localeCompare(right.delivery.createdAt)
      || left.delivery.event.eventId.localeCompare(right.delivery.event.eventId))[0];
}

async function deliver(options: AuthoritativeNativeQemuEventDispatcherOptions, pending: Pending,
  shutdown: AbortSignal, timeoutMilliseconds: number): Promise<string> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(timeoutMilliseconds)]);
  const event = pending.delivery.event;
  const requestId = randomUUID();
  const discoveryResult = admissionSchema.safeParse(await requestJson(options.httpClient, {
    endpoint: options.dependency.endpoint, method: "POST",
    path: `/v1/qemu-projects/${event.projectId}/admission/discover`, authorization: authorization(options.dependency.query),
    body: JSON.stringify({ schemaVersion: 1, requestId }), signal
  }, 200));
  if (!discoveryResult.success) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU admission response is malformed");
  }
  const discovered = discoveryResult.data;
  if (discovered.requestId !== requestId || discovered.admission.projectId !== event.projectId
    || discovered.admission.policyRevision !== event.policyRevision
    || discovered.admission.requiredJobSetRevision !== event.requiredJobSetRevision
    || !discovered.admission.requiredQemuJobs.includes(event.jobName)) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU admission does not match authoritative event");
  }
  const body = JSON.stringify({ schemaVersion: 1, requestId: eventRequestId(event.eventId),
    admissionGeneration: discovered.admission.admissionGeneration, event });
  const acknowledgementResult = acknowledgementSchema.safeParse(await requestJson(options.httpClient, {
    endpoint: options.dependency.endpoint, method: "POST", path: "/v1/qemu-events",
    authorization: authorization(options.dependency.eventIntake), body, signal
  }, [200, 201]));
  if (!acknowledgementResult.success) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU acknowledgement is malformed");
  }
  const acknowledged = acknowledgementResult.data;
  if (!isDeepStrictEqual(acknowledged, { schemaVersion: 1, eventId: event.eventId, recorded: true })) {
    throw new AuthoritativeNativeQemuEventDeliveryError("QEMU acknowledgement does not match delivery");
  }
  return discovered.admission.admissionGeneration;
}

async function requestJson(client: AdmissionVerifierHttpClient,
  input: Parameters<AdmissionVerifierHttpClient["request"]>[0], expectedStatus: number | readonly number[]): Promise<unknown> {
  let response: AdmissionVerifierHttpResponse;
  try { response = await client.request(input); }
  catch (error) { throw new AuthoritativeNativeQemuEventDeliveryError("QEMU delivery request failed", { cause: error }); }
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
  readonly name = "AuthoritativeNativeQemuEventDeliveryError";
}
