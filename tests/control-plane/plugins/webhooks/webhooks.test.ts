import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ExternalWebhookStore, createExternalWebhookDispatcher, externalWebhookSubscriberSchema, externalWebhookEventSchema,
  startWebhookService, webhookConfigurationSchema, controlPlanePlugin } from "../../../../packages/control-plane/plugins/webhooks/src/index.js";
import { webhookEventSourceExtension, type DurableWebhookEventSource } from "../../../../packages/control-plane/plugins/webhooks/src/extensions.js";
import { startControlPlanePlugins } from "@slop-lab/dim-control-plane-core";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const secret = `whsec_${Buffer.alloc(32, 91).toString("base64")}`;
const event = { identity: "immutable-artifact-123", projectId: "project-a", type: "example.artifact.created", subject: "projects/project-a/artifacts/123", data: { digest: "a".repeat(64) } };
const source: DurableWebhookEventSource = { name: "artifacts", async read() { return [event]; } };
const target = (endpoint: string, id = "audit", maximumAttempts = 1) => externalWebhookSubscriberSchema.parse({ id, endpoint, secret,
  projects: ["project-a"], events: [event.type], maximumAttempts, timeoutMilliseconds: 500, retryMilliseconds: 50 });
const generationId = "b".repeat(64), password = "operator-secret-".repeat(3);
const headers = { authorization: `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`, "x-dim-generation-id": generationId, "content-type": "application/json" };

it("validates independent configuration and refuses absent or duplicate event capabilities", async () => {
  const config = webhookConfigurationSchema.parse({ schemaVersion: 1, stateDirectory: await temporary(), generationId,
    sources: [source.name], subscribers: [target("https://example.com/hooks")], operators: [{ username: "operator", password, projects: ["project-a"] }], listen: { host: "127.0.0.1", port: 0 } });
  expect(() => webhookConfigurationSchema.parse({ ...config, subscribers: [config.subscribers[0], config.subscribers[0]] })).toThrow(/duplicate/);
  expect(() => target("http://third-party.example/hook")).toThrow();
  expect(() => target("https://user:secret@example.com/hook")).toThrow();
  await expect(startControlPlanePlugins([{ plugin: controlPlanePlugin, config }], new AbortController().signal)).rejects.toThrow(/missing required/);
  const running = await startControlPlanePlugins([{ plugin: { apiVersion: 1, name: "artifact-source", configure() {
    return { extensions: [webhookEventSourceExtension(source)], async start() { return { async close() {} }; } };
  } }, config: {} }, { plugin: controlPlanePlugin, config }], new AbortController().signal);
  await running.close();
});

it("signs exact CloudEvents and isolates subscriber failures while namespacing source identities", async () => {
  const calls: { headers: IncomingHttpHeaders; body: string }[] = [];
  const failed = await receiver((headers, body) => { calls.push({ headers, body }); return 503; });
  const successes: string[] = [], healthy = await receiver((_headers, body) => { successes.push(body); return 204; });
  const dispatcher = createExternalWebhookDispatcher({ stateDirectory: await temporary(), subscribers: [target(failed), target(healthy, "healthy")],
    sources: [source, { ...source, name: "other-artifacts" }] });
  dispatcher.start(); cleanups.push(() => dispatcher.close());
  await until(() => dispatcher.store.list("project-a").length === 4 && dispatcher.store.list("project-a").every(({ status }) => status === "failed" || status === "delivered"));
  expect(successes).toHaveLength(2); expect(calls).toHaveLength(2);
  const ids = new Set<string>();
  for (const call of calls) {
    const parsed = externalWebhookEventSchema.parse(JSON.parse(call.body)); ids.add(parsed.id);
    expect(parsed).toMatchObject({ type: event.type, data: event.data });
    expect(call.headers["webhook-id"]).toBe(parsed.id);
    expect(call.headers["webhook-signature"]).toBe(`v1,${createHmac("sha256", Buffer.alloc(32, 91)).update(`${parsed.id}.${call.headers["webhook-timestamp"]}.${call.body}`).digest("base64")}`);
    expect(call.body).not.toContain(secret);
  }
  expect(ids.size).toBe(2);
});

it("backfills after restart and exposes generation-bound scoped idempotent recovery on its own operator listener", async () => {
  let status = 503;
  const received: string[] = [], endpoint = await receiver((_headers, body) => { received.push(body); return status; });
  const config = webhookConfigurationSchema.parse({ schemaVersion: 1, stateDirectory: await temporary(), generationId, sources: [source.name],
    subscribers: [target(endpoint)], operators: [{ username: "operator", password, projects: ["project-a"] }], listen: { host: "127.0.0.1", port: 0 } });
  const abort = new AbortController(); let service = await startWebhookService(config, [source], abort.signal);
  cleanups.push(() => service.close());
  const path = "/v1/projects/project-a/webhook-deliveries";
  await until(() => service.dispatcher.store.list("project-a")[0]?.status === "failed");
  const eventId = service.dispatcher.store.list("project-a")[0]!.eventId, sourceUrn = service.dispatcher.store.source;
  expect((await fetch(service.origin + path)).status).toBe(401);
  expect((await fetch(service.origin + path.replace("project-a", "project-b"), { headers })).status).toBe(404);
  expect((await fetch(service.origin + path, { headers: { ...headers, "x-dim-generation-id": "f".repeat(64) } })).status).toBe(409);
  await service.close(); status = 204;
  service = await startWebhookService(config, [source], abort.signal);
  expect(service.dispatcher.store.source).toBe(sourceUrn);
  const route = `${service.origin}${path}/audit/${eventId}/retry`, requestId = randomUUID();
  expect((await fetch(route, { method: "POST", headers: { ...headers, origin: "https://other.example" }, body: JSON.stringify({ requestId }) })).status).toBe(403);
  for (let attempt = 0; attempt < 2; attempt++) expect((await fetch(route, { method: "POST", headers, body: JSON.stringify({ requestId }) })).status).toBe(200);
  await until(() => service.dispatcher.store.list("project-a")[0]?.status === "delivered");
  await service.close(); service = await startWebhookService(config, [source], abort.signal);
  expect((await fetch(`${service.origin}${path}/audit/${eventId}/retry`, { method: "POST", headers, body: JSON.stringify({ requestId }) })).status).toBe(200);
  expect(received).toHaveLength(2);
});
it("keeps crash-consumed attempts durable and never follows subscriber redirects", async () => {
  let escaped = 0;
  const sink = await receiver(() => { escaped++; return 200; });
  const redirect = createServer((_request, response) => { response.writeHead(302, { location: sink }).end(); });
  const endpoint = await listen(redirect), root = await temporary(), subscriber = target(endpoint);
  const store = new ExternalWebhookStore(join(root, "external-webhooks.sqlite3"));
  const queued = externalWebhookEventSchema.parse({ specversion: "1.0", source: store.source, id: "a".repeat(64), type: event.type, subject: event.subject, datacontenttype: "application/json", data: event.data });
  store.enqueue(subscriber, event.projectId, queued);
  expect(store.claim(subscriber, Date.now())?.delivery.attempts).toBe(1);
  store.close();
  const dispatcher = createExternalWebhookDispatcher({ stateDirectory: root, subscribers: [subscriber], sources: [] });
  dispatcher.start(); cleanups.push(() => dispatcher.close());
  await until(() => dispatcher.store.list(event.projectId)[0]?.status === "failed");
  dispatcher.store.retry(event.projectId, subscriber, queued.id, randomUUID());
  await until(() => dispatcher.store.list(event.projectId)[0]?.lastStatus === 302);
  expect(escaped).toBe(0);
});

async function temporary() { const root = await mkdtemp(join(tmpdir(), "dim-webhook-plugin-")); cleanups.push(() => rm(root, { recursive: true, force: true })); return root; }
async function receiver(handle: (headers: IncomingHttpHeaders, body: string) => number) {
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); response.writeHead(handle(request.headers, Buffer.concat(chunks).toString("utf8"))).end(); });
  const origin = await listen(server); return origin;
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener"); return `http://127.0.0.1:${address.port}`;
}
async function until(check: () => boolean) { const deadline = Date.now() + 7000; while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); } }
