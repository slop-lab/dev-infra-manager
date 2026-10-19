import { AuthoritativeNativeReviewAdmissionBusyError } from "./authoritative-native-review-controller.js";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExternalWebhookSubscriber } from "./external-webhook-config.js";
import { ExternalWebhookStore, type ExternalWebhookEvent } from "./external-webhook-store.js";

export type ExternalWebhookDispatcher = ReturnType<typeof createExternalWebhookDispatcher>;
export function createExternalWebhookDispatcher(input: {
  readonly stateDirectory: string;
  readonly subscribers: readonly ExternalWebhookSubscriber[];
  readonly events: (source: string) => Promise<readonly { readonly projectId: string; readonly event: ExternalWebhookEvent }[]>;
}) {
  const store = new ExternalWebhookStore(join(input.stateDirectory, "external-webhooks.sqlite3"));
  try { for (const subscriber of input.subscribers) store.assertBinding(subscriber); }
  catch (error) { store.close(); throw error; }
  const shutdown = new AbortController();
  let task: Promise<void> | undefined;
  let failure: Error | undefined;
  let wakeScan: (() => void) | undefined;
  let scanRequested = false;
  return {
    store,
    start(): void {
      task ??= Promise.all([loop(scan, 5000), ...input.subscribers.map((subscriber) => loop(() => deliver(subscriber), 250))])
        .then(() => undefined);
    },
    wake(): void { scanRequested = true; wakeScan?.(); },
    healthy(): boolean { return failure === undefined; },
    async close(): Promise<void> {
      shutdown.abort();
      await task;
      store.close();
      if (failure !== undefined) throw failure;
    }
  };
  async function loop(operation: () => Promise<void>, interval: number): Promise<void> {
    try {
      while (!shutdown.signal.aborted) {
        try { await operation(); }
        catch (error) { if (!(error instanceof AuthoritativeNativeReviewAdmissionBusyError)) throw error; }
        if (operation === scan) {
          if (scanRequested) { scanRequested = false; continue; }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(finish, interval);
            function finish(): void {
              clearTimeout(timer);
              shutdown.signal.removeEventListener("abort", finish);
              wakeScan = undefined;
              resolve();
            }
            wakeScan = finish;
            shutdown.signal.addEventListener("abort", finish, { once: true });
            if (shutdown.signal.aborted) finish();
          });
          continue;
        }
        try { await delay(interval, undefined, { signal: shutdown.signal }); }
        catch (error) { if (!shutdown.signal.aborted) throw error; }
      }
    } catch (error) {
      if (shutdown.signal.aborted) return;
      failure = error instanceof Error ? error : new Error("external webhook persistence failed");
    }
  }
  async function scan(): Promise<void> {
    // No network I/O runs inside the Git authority serialization gate.
    for (const { projectId, event } of await input.events(store.source)) {
      for (const subscriber of input.subscribers) {
        if (subscriber.projects.includes(projectId) && subscriber.events.includes(event.type)) {
          store.enqueue(subscriber, projectId, event);
        }
      }
    }
  }
  async function deliver(subscriber: ExternalWebhookSubscriber): Promise<void> {
    const claimed = store.claim(subscriber, Date.now());
    if (claimed === undefined) return;
    const { delivery, body } = claimed;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(subscriber.secret.slice(6), "base64"))
      .update(`${delivery.eventId}.${timestamp}.${body}`).digest("base64");
    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetch(subscriber.endpoint, { method: "POST", redirect: "manual",
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(subscriber.timeoutMilliseconds)]),
        headers: { "content-type": "application/cloudevents+json", "webhook-id": delivery.eventId,
          "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`,
          "x-dim-webhook-attempt-id": delivery.attemptId ?? "" }, body });
      status = response.status;
      await response.body?.cancel();
      if (status < 200 || status >= 300) error = `subscriber returned HTTP ${status}`;
    } catch {
      // URLs can contain private query keys; do not persist fetch exceptions containing them.
      error = shutdown.signal.aborted ? "delivery interrupted by service shutdown" : "subscriber request failed or timed out";
    }
    store.finish(subscriber, delivery, status, error);
  }
}
