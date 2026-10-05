import { setTimeout as delay } from "node:timers/promises";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import { nativeStatusAcknowledged, type NativeTerminalEvent } from "./nativeOrdinaryResultProtocol.js";
import type { NativeReportDelivery } from "./nativeOrdinaryResultStore.js";

const requestTimeoutMilliseconds = 5_000;
const maximumResponseBytes = 64 * 1024;
const terminalDenials = new Set([400, 401, 403, 404, 409]);

export type NativeGitResultReporterConfig = {
  readonly endpoint: "http://native-git:8080";
  readonly serviceId: "native-main";
  readonly resultReporter: {
    readonly username: string;
    readonly password: string;
  };
};

export interface NativeGitResultReporterClient {
  send(eventJson: string, event: NativeTerminalEvent, signal: AbortSignal): Promise<"acknowledged" | "denied">;
}

interface NativeReportStore {
  takeDue(): NativeReportDelivery | undefined;
  retry(delivery: NativeReportDelivery): void;
  complete(claimId: string, outcome: "delivered" | "denied", denialCode?: string): void;
  parseDelivery(delivery: NativeReportDelivery): NativeTerminalEvent;
}

export function createNativeGitResultReporterClient(
  config: NativeGitResultReporterConfig,
  httpClient: NativeGitAdmissionHttpClient
): NativeGitResultReporterClient {
  if (config.endpoint !== "http://native-git:8080" || config.serviceId !== "native-main") {
    throw new NativeGitResultReporterUnavailableError();
  }
  const endpoint = config.endpoint;
  const reporterUsername = config.resultReporter.username;
  const reporterPassword = config.resultReporter.password;
  const authorization = `Basic ${Buffer.from(`${reporterUsername}:${reporterPassword}`, "utf8").toString("base64")}`;
  return {
    async send(eventJson, event, signal) {
      let response: NativeGitAdmissionHttpResponse;
      try {
        response = await httpClient.request({
          endpoint,
          method: "POST",
          path: `/v1/projects/${event.payload.descriptor.projectId}/repositories/${event.payload.descriptor.repositoryId}`
            + `/reviews/${event.payload.reviewId}/statuses`,
          authorization,
          body: eventJson,
          signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
        });
      } catch (error) {
        throw new NativeGitResultReporterUnavailableError({ cause: error });
      }
      if (terminalDenials.has(response.statusCode)) return "denied";
      if (response.statusCode !== 201 || response.contentType !== "application/json; charset=utf-8"
        || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
        throw new NativeGitResultReporterUnavailableError();
      }
      let body: unknown;
      try {
        body = JSON.parse(response.body.toString("utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) throw new NativeGitResultReporterUnavailableError({ cause: error });
        throw error;
      }
      try {
        if (!nativeStatusAcknowledged(body, event, reporterUsername)) throw new NativeGitResultReporterUnavailableError();
      } catch (error) {
        if (error instanceof NativeGitResultReporterUnavailableError) throw error;
        throw new NativeGitResultReporterUnavailableError({ cause: error });
      }
      return "acknowledged";
    }
  };
}

export class NativeGitResultReporter {
  readonly #store: NativeReportStore;
  readonly #client: NativeGitResultReporterClient;
  readonly #controller = new AbortController();
  readonly #worker: Promise<void>;

  constructor(store: NativeReportStore, client: NativeGitResultReporterClient) {
    this.#store = store;
    this.#client = client;
    this.#worker = this.#run();
  }

  async close(): Promise<void> {
    this.#controller.abort();
    await this.#worker;
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const delivery = this.#store.takeDue();
      if (delivery === undefined) {
        try {
          await delay(100, undefined, { signal: this.#controller.signal });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
          throw error;
        }
        continue;
      }
      const event = this.#store.parseDelivery(delivery);
      try {
        const outcome = await this.#client.send(delivery.terminalEventJson, event, this.#controller.signal);
        const state = outcome === "acknowledged" ? "delivered" : "denied";
        const denialCode = outcome === "denied" ? "native-denied" : undefined;
        this.#store.complete(delivery.claimId, state, denialCode);
      } catch (error) {
        if (!(error instanceof NativeGitResultReporterUnavailableError)) throw error;
        if (this.#controller.signal.aborted) return;
        this.#store.retry(delivery);
      }
    }
  }
}

export class NativeGitResultReporterUnavailableError extends Error {
  readonly name = "NativeGitResultReporterUnavailableError";

  constructor(options?: ErrorOptions) {
    super("native Git result reporter is unavailable", options);
  }
}
