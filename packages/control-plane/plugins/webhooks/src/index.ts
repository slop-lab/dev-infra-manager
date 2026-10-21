import { timingSafeEqual } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import { z } from "zod";
import { createExternalWebhookDispatcher } from "./external-webhook-dispatcher.js";
import { externalWebhookSubscriberSchema } from "./external-webhook-config.js";
import { WEBHOOK_EVENT_SOURCE_EXTENSION, webhookEventSources, type DurableWebhookEventSource } from "./plugin-api.js";
export * from "./external-webhook-config.js";
export * from "./external-webhook-store.js";
export * from "./external-webhook-dispatcher.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const webhookConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  stateDirectory: z.string().refine(isAbsolute),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  sources: z.array(identifier).min(1).max(32),
  subscribers: z.array(externalWebhookSubscriberSchema).min(1).max(32),
  operators: z.array(z.object({ username: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    password: z.string().min(32).max(256), projects: z.array(identifier).min(1).max(1000) }).strict()).min(1).max(32),
  listen: z.object({ host: z.string().min(1).default("127.0.0.1"), port: z.number().int().min(0).max(65535) }).strict()
}).strict().superRefine((value, context) => {
  for (const [kind, names] of [["source", value.sources], ["subscriber", value.subscribers.map(({ id }) => id)], ["operator", value.operators.map(({ username }) => username)]] as const)
    if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: `duplicate webhook ${kind}` });
});
export type WebhookConfiguration = z.infer<typeof webhookConfigurationSchema>;

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "webhooks",
  configure(raw) {
    const config = webhookConfigurationSchema.parse(raw);
    return { requiresExtensions: config.sources.map((name) => ({ kind: WEBHOOK_EVENT_SOURCE_EXTENSION, name })),
      async start(context) {
        const available = webhookEventSources(context.extensions);
        return startWebhookService(config, available.filter(({ name }) => config.sources.includes(name)), context.signal);
      } };
  }
};
export async function startWebhookService(config: WebhookConfiguration, sources: readonly DurableWebhookEventSource[], signal: AbortSignal) {
  signal.throwIfAborted();
  if (config.sources.some((name) => !sources.some((source) => source.name === name))) throw new Error("required webhook event source is unavailable");
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.stateDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("webhook state directory must be private and owned");
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, ".owner.lock"));
  if (!guard) throw new Error("webhook state directory is already in use");
  let dispatcher: ReturnType<typeof createExternalWebhookDispatcher>;
  try { dispatcher = createExternalWebhookDispatcher({ stateDirectory: config.stateDirectory, subscribers: config.subscribers, sources }); }
  catch (error) { await guard.release(); throw error; }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { if (response.headersSent) response.destroy(); else send(response, 400, { error: "invalid webhook operator request" }); }); });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    signal.removeEventListener("abort", aborted);
    server.closeAllConnections();
    const failures: unknown[] = [];
    for (const operation of [async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
      () => dispatcher.close(), () => guard.release()]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "webhook shutdown failed");
  })();
  const aborted = () => { void close().catch(() => {}); };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen.port, config.listen.host, resolve); });
    signal.throwIfAborted(); signal.addEventListener("abort", aborted, { once: true });
    dispatcher.start();
  } catch (error) { await close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { await close(); throw new Error("webhook listener unavailable"); }
  return { close, origin: `http://${config.listen.host}:${address.port}`, dispatcher };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://webhooks.invalid");
    const operator = config.operators.find(({ username, password }) => {
      const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    if (!operator) { send(response, 401, { error: "unauthorized" }); return; }
    if (request.method === "GET" && url.pathname === "/v1/webhook-operator-identity" && !url.search) {
      send(response, 200, { schemaVersion: 1, role: "webhook-operator", generationId: config.generationId }); return;
    }
    const match = /^\/v1\/projects\/([a-z0-9][a-z0-9-]{0,63})\/webhook-deliveries(?:\/([a-z0-9][a-z0-9-]{0,63})\/([0-9a-f]{64})\/retry)?$/.exec(url.pathname);
    if (!match || url.search || !operator.projects.includes(match[1] ?? "")) { send(response, 404, { error: "not found" }); return; }
    if (request.headers["x-dim-generation-id"] !== config.generationId) { send(response, 409, { error: "webhook operator generation conflicts" }); return; }
    const projectId = match[1]!;
    if (request.method === "GET" && match[2] === undefined) { send(response, 200, { healthy: dispatcher.healthy(), deliveries: dispatcher.store.list(projectId) }); return; }
    if (request.method !== "POST" || match[2] === undefined) { send(response, 404, { error: "not found" }); return; }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json"
      || request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}`) {
      send(response, 403, { error: "webhook retry requires same-origin JSON" }); return;
    }
    const subscriber = config.subscribers.find(({ id, projects }) => id === match[2] && projects.includes(projectId));
    if (!subscriber || !match[3]) { send(response, 404, { error: "not found" }); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4096) throw new Error("retry request too large"); chunks.push(bytes); }
    const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    try { dispatcher.store.retry(projectId, subscriber, match[3], requestId); }
    catch { send(response, 409, { error: "delivery cannot be retried with this request" }); return; }
    send(response, 200, { requestId, accepted: true });
  }
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body));
}
