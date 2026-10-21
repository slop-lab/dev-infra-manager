import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";

/** Producers own domain payloads and immutable identities; delivery owns its outbox. */
export interface DurableWebhookEvent {
  readonly identity: string;
  readonly projectId: string;
  readonly type: string;
  readonly subject: string;
  readonly data: Readonly<Record<string, string | number>>;
}
export interface DurableWebhookEventSource {
  readonly name: string;
  read(): Promise<readonly DurableWebhookEvent[]>;
  /** A latency hint only: startup and periodic durable backfill remain mandatory. */
  subscribeWake?(wake: () => void): () => void;
}
export const WEBHOOK_EVENT_SOURCE_EXTENSION = "dim.webhooks.event-source";
export function webhookEventSourceExtension(source: DurableWebhookEventSource): ControlPlaneExtension {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(source.name)) throw new Error("invalid webhook event source name");
  return { kind: WEBHOOK_EVENT_SOURCE_EXTENSION, name: source.name, value: source };
}
export function webhookEventSources(extensions: readonly ControlPlaneExtension[]): readonly DurableWebhookEventSource[] {
  return extensions.filter(({ kind }) => kind === WEBHOOK_EVENT_SOURCE_EXTENSION).map(({ name, value }) => {
    if (!("read" in value) || typeof value.read !== "function"
      || !("name" in value) || value.name !== name
      || "subscribeWake" in value && typeof value.subscribeWake !== "function") throw new Error(`invalid webhook event source '${name}'`);
    return value as DurableWebhookEventSource;
  });
}
