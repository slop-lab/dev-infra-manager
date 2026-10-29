import type { CiDeliveryPublicationFaults } from "./delivery-publication.js";
import { join } from "node:path";
import {
  acknowledgeAuthoritativeNativeDelivery,
  auditAuthoritativeNativeDeliveryOutbox,
  readPendingAuthoritativeNativeDeliveries,
  supersedeAuthoritativeNativeDelivery,
  type AuthoritativeNativePendingDelivery,
} from "./authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import { releaseCatalogDeliveryIntents } from "./delivery-intent-catalog.js";

export type CiDeliveryReceipt = {
  readonly serviceId: string;
  readonly generationId: string;
  readonly executionId: string;
};

export interface CiDeliverySubmitPort {
  submit(input: {
    readonly generationId: string;
    readonly event: AuthoritativeNativePendingDelivery["event"];
    readonly signal: AbortSignal;
  }): Promise<CiDeliveryReceipt>;
}

export type CiDeliveryDispatcher = {
  readonly start: () => void;
  readonly wake: () => void;
  readonly stop: () => void;
  readonly close: () => Promise<void>;
  readonly healthy: () => boolean;
  readonly whenFailed: () => Promise<Error>;
};

export type CiDeliveryDispatcherOptions = {
  readonly serviceId: string;
  readonly destination: string;
  readonly eventCodec: import("./authoritative-native-delivery-binding.js").CiDeliveryEventCodec;
  readonly generationId: string;
  readonly repositories: () => readonly string[] | Promise<readonly string[]>;
  readonly submit: CiDeliverySubmitPort;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  readonly transientError?: (error: unknown) => boolean;
  readonly deliveryFaults?: CiDeliveryPublicationFaults;
  readonly minimumRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
  readonly idleMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
};

export async function createCiDeliveryDispatcher(options: CiDeliveryDispatcherOptions): Promise<CiDeliveryDispatcher> {
  const timing = {
    minimum: options.minimumRetryMilliseconds ?? 250,
    maximum: options.maximumRetryMilliseconds ?? 30_000,
    idle: options.idleMilliseconds ?? 1_000,
    request: options.requestTimeoutMilliseconds ?? 5_000,
  };
  const binding = authoritativeNativeDeliveryBinding(options.serviceId, options.destination, options.eventCodec);
  const ownedRepositories = new Set<string>();
  const repositories = async (): Promise<readonly string[]> => {
    const selected = await options.repositories();
    for (const repository of selected) ownedRepositories.add(repository);
    return selected;
  };
  if (Object.values(timing).some((value) => !Number.isInteger(value) || value < 1 || value > 30_000)
    || timing.minimum > timing.maximum) {
    throw new CiDeliveryError("CI delivery timing is invalid");
  }
  await options.serialize(async () => {
    await Promise.all((await repositories()).map((repository) =>
      auditAuthoritativeNativeDeliveryOutbox(repository, binding, options.generationId)));
    await pendingDelivery(options, binding, await repositories());
  });
  const shutdown = new AbortController();
  let task: Promise<void> | undefined;
  let wakeCurrent: (() => void) | undefined;
  let failure: Error | undefined;
  let reportFailure: ((error: Error) => void) | undefined;
  const failed = new Promise<Error>((resolve) => { reportFailure = resolve; });
  let persistenceUnavailable = false;
  return {
    start() {
      task ??= run().catch((error: unknown) => {
        failure = error instanceof Error ? error : new CiDeliveryError("CI delivery failed");
        reportFailure?.(failure);
      });
    },
    wake() { wakeCurrent?.(); },
    stop() {
      shutdown.abort();
      wakeCurrent?.();
    },
    healthy() { return failure === undefined && !persistenceUnavailable; },
    whenFailed() { return failed; },
    async close() {
      shutdown.abort();
      wakeCurrent?.();
      await task;
      for (const repository of ownedRepositories) {
        releaseCatalogDeliveryIntents(join(repository, "dim-git-ci-deliveries", "intents"));
      }
      if (failure !== undefined) throw failure;
    },
  };

  async function run(): Promise<void> {
    let retry = timing.minimum;
    while (!shutdown.signal.aborted) {
      try {
        const pending = await options.serialize(async () => pendingDelivery(
          options, binding, await repositories(),
        ));
        if (pending === undefined) {
          await wait(timing.idle);
          continue;
        }
        let receipt: CiDeliveryReceipt;
        try {
          receipt = await options.submit.submit({
            generationId: options.generationId,
            event: pending.delivery.event,
            signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timing.request)]),
          });
        } catch (error) {
          if (!(error instanceof CiDeliveryRejectedError)) throw error;
          await options.serialize(() => supersedeAuthoritativeNativeDelivery(
            pending.repository,
            pending.delivery,
            binding,
            error.statusCode,
            timing.minimum,
          ));
          retry = timing.minimum;
          continue;
        }
        if (receipt.serviceId !== options.serviceId || receipt.generationId !== options.generationId) {
          throw new CiDeliveryError("CI delivery receipt does not match the selected provider");
        }
        await options.serialize(() => acknowledgeAuthoritativeNativeDelivery(
          pending.repository,
          pending.delivery,
          receipt,
          binding,
          options.deliveryFaults,
        ));
        persistenceUnavailable = false;
        retry = timing.minimum;
      } catch (error) {
        if (shutdown.signal.aborted) return;
        const filesystem = transientFilesystemError(error);
        if (!(error instanceof CiDeliveryError) && !filesystem && options.transientError?.(error) !== true) throw error;
        if (filesystem) persistenceUnavailable = true;
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

async function pendingDelivery(
  options: CiDeliveryDispatcherOptions,
  binding: ReturnType<typeof authoritativeNativeDeliveryBinding>,
  repositories: readonly string[],
): Promise<Pending | undefined> {
  const candidates = await Promise.all(repositories.map(async (repository) => {
    const delivery = (await readPendingAuthoritativeNativeDeliveries(repository, 1, binding, options.generationId))[0];
    return delivery === undefined ? undefined : { repository, delivery };
  }));
  return candidates.filter((candidate): candidate is Pending => candidate !== undefined)
    .sort((left, right) => left.delivery.createdAt.localeCompare(right.delivery.createdAt)
      || left.delivery.event.namespaceId.localeCompare(right.delivery.event.namespaceId)
      || left.delivery.event.reviewId.localeCompare(right.delivery.event.reviewId)
      || left.delivery.event.checkName.localeCompare(right.delivery.event.checkName)
      || left.delivery.event.eventId.localeCompare(right.delivery.event.eventId))[0];
}

function transientFilesystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ENOSPC", "EIO", "EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EACCES"].includes(error.code);
}

type Pending = { readonly repository: string; readonly delivery: AuthoritativeNativePendingDelivery };

export class CiDeliveryError extends Error {
  readonly name: string = "CiDeliveryError";
}

export class CiDeliveryRejectedError extends CiDeliveryError {
  readonly name = "CiDeliveryRejectedError";
  constructor(readonly statusCode: 404 | 409) {
    super("CI delivery event is stale");
  }
}
