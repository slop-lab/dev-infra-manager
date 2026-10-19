import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { externalWebhookSubscriberSchema } from "../../../../packages/control-plane/plugins/native-git/src/external-webhook-config.js";
import { createExternalWebhookDispatcher } from "../../../../packages/control-plane/plugins/native-git/src/external-webhook-dispatcher.js";
import { ExternalWebhookStore, externalWebhookEventSchema } from "../../../../packages/control-plane/plugins/native-git/src/external-webhook-store.js";
import { parseNativeGitBundleConfig } from "../../../../packages/control-plane/plugins/native-git/src/bundle-config.js";
import { nativeBundleReviewFixture, createBundleReview } from "./nativeBundleReviewFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { cleanupFinalizeFixtures, closeFinalizeService, startFinalizeService, generationId,
  hostPromoterAuthorization, foreignHostPromoterAuthorization, humanReviewerAuthorization } from "./nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "./bundleConfigFixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await cleanupFinalizeFixtures(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const secret = `whsec_${Buffer.alloc(32, 91).toString("base64")}`;
const event = externalWebhookEventSchema.parse({ specversion: "1.0", id: "a".repeat(64),
  source: "urn:dim:native-git:00000000-0000-4000-8000-000000000000", type: "dev.dim.git.review.created",
  subject: "projects/project-a/repositories/root", datacontenttype: "application/json",
  data: { projectId: "project-a", reviewId: "b".repeat(64) } });
const subscriber = (endpoint: string, id = "extension", maximumAttempts = 2) => externalWebhookSubscriberSchema.parse({
  id, endpoint, secret, projects: ["project-a"], events: ["dev.dim.git.review.created", "dev.dim.git.ref.promoted"],
  maximumAttempts, timeoutMilliseconds: 500, retryMilliseconds: 50
});

it("validates operator-only endpoint allowlists, signing keys, and unique subscriber ids", () => {
  for (const endpoint of ["http://third-party.example/hook", "https://user:secret@example.com/hook", "https://example.com/#fragment"]) {
    expect(() => subscriber(endpoint)).toThrow();
  }
  expect(() => externalWebhookSubscriberSchema.parse({ ...subscriber("https://example.com/hook"), secret: "whsec_bad" })).toThrow();
  expect(() => parseNativeGitBundleConfig({ ...idleNativeConfig(), webhooks: [subscriber("https://example.com/hook"), subscriber("https://example.com/two")] })).toThrow();
});

it("signs raw CloudEvents, isolates targets, persists retry budgets and accepts ordinary 2xx", async () => {
  const root = await temporary();
  const calls: { headers: IncomingHttpHeaders; body: string }[] = [];
  const failed = await receiver((headers, body) => { calls.push({ headers, body }); return 503; });
  const successes: string[] = [];
  const healthy = await receiver((_headers, body) => { successes.push(body); return 204; });
  const target = subscriber(failed.origin);
  const dispatcher = createExternalWebhookDispatcher({ stateDirectory: root,
    subscribers: [target, subscriber(healthy.origin, "healthy")],
    events: async () => [{ projectId: "project-a", event }] });
  const durableSource = dispatcher.store.source;
  dispatcher.start();
  await until(() => dispatcher.store.list("project-a").some((row) => row.status === "failed"));
  expect(successes).toHaveLength(1);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    const timestamp = call.headers["webhook-timestamp"];
    const expected = createHmac("sha256", Buffer.alloc(32, 91)).update(`${event.id}.${timestamp}.${call.body}`).digest("base64");
    expect(call.headers["webhook-signature"]).toBe(`v1,${expected}`);
    expect(call.headers["webhook-id"]).toBe(event.id);
    expect(JSON.parse(call.body)).toEqual(event);
  }
  expect(calls[0]?.headers["x-dim-webhook-attempt-id"]).not.toBe(calls[1]?.headers["x-dim-webhook-attempt-id"]);
  await dispatcher.close();
  const restarted = createExternalWebhookDispatcher({ stateDirectory: root, subscribers: [target], events: async () => [{ projectId: "project-a", event }] });
  expect(restarted.store.source).toBe(durableSource);
  const independent = new ExternalWebhookStore(join(await temporary(), "independent.sqlite3"));
  expect(independent.source).not.toBe(durableSource);
  independent.close();
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(calls).toHaveLength(2);
  expect(restarted.store.list("project-a").find((row) => row.subscriberId === target.id)?.status).toBe("failed");
  const requestId = randomUUID();
  restarted.store.retry("project-a", target, event.id, requestId);
  restarted.store.retry("project-a", target, event.id, requestId);
  expect(() => restarted.store.retry("project-a", target, event.id, randomUUID())).toThrow();
  await until(() => calls.length === 4);
  await restarted.close();
  const store = new ExternalWebhookStore(join(root, "external-webhooks.sqlite3"));
  expect(() => store.assertBinding({ ...target, endpoint: `${target.endpoint}/changed` })).toThrow(/new subscriber id/);
  store.close();
});

it("never follows redirects and preserves a crashed attempt as consumed with stable event identity", async () => {
  const root = await temporary();
  let redirected = 0;
  const sink = await receiver(() => { redirected++; return 200; });
  const redirect = createServer((_request, response) => { response.writeHead(302, { location: sink.origin }); response.end(); });
  const origin = await listen(redirect);
  const target = subscriber(origin, "redirect", 1);
  const store = new ExternalWebhookStore(join(root, "external-webhooks.sqlite3"));
  store.enqueue(target, "project-a", event);
  expect(store.claim(target, Date.now())?.delivery.attempts).toBe(1);
  store.close();
  const dispatcher = createExternalWebhookDispatcher({ stateDirectory: root, subscribers: [target], events: async () => [{ projectId: "project-a", event }] });
  dispatcher.start();
  await until(() => dispatcher.store.list("project-a")[0]?.status === "failed");
  dispatcher.store.retry("project-a", target, event.id, randomUUID());
  await until(() => dispatcher.store.list("project-a")[0]?.lastStatus === 302);
  expect(redirected).toBe(0);
  await dispatcher.close();
});

it("publishes no-CI reviews and finalized promotions; scoped generation-bound operators can inspect and retry across restart", { timeout: 20_000 }, async () => {
  let status = 503;
  const received: unknown[] = [];
  const target = subscriber((await receiver((_headers, body) => { received.push(JSON.parse(body)); return status; })).origin, "audit", 1);
  const config = { webhooks: [target] };
  const fixture = await nativeBundleReviewFixture("external-webhooks", undefined, authoritativePolicy(["owner"], [], []),
    undefined, undefined, undefined, undefined, config, undefined, "jobs: {}\n");
  const created = await createBundleReview(fixture.service);
  expect(created.events).toEqual([]);
  const { review } = created;
  const headers = { authorization: hostPromoterAuthorization, "x-dim-generation-id": generationId, "content-type": "application/json" };
  const route = "/v1/projects/project-a/webhook-deliveries";
  await until(async () => {
    const response = await fetch(`${fixture.service.origin}${route}`, { headers });
    const body: unknown = await response.json();
    return JSON.stringify(body).includes('"status":"failed"');
  });
  const denied = await fetch(`${fixture.service.origin}${route}`, { headers: { ...headers, authorization: humanReviewerAuthorization } });
  expect(denied.status).toBe(403);
  expect((await fetch(`${fixture.service.origin}${route}`, { headers: { ...headers, authorization: foreignHostPromoterAuthorization } })).status).toBe(404);
  expect((await fetch(`${fixture.service.origin}${route}`, { headers: { ...headers, "x-dim-generation-id": "f".repeat(64) } })).status).toBe(409);
  const createdEvent = externalWebhookEventSchema.parse(received[0]);
  expect(createdEvent).toMatchObject({ type: "dev.dim.git.review.created", data: { reviewId: review.reviewId } });
  expect(JSON.stringify(received)).not.toContain(secret);
  const approval = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}/approvals`, {
    method: "POST", headers: { ...headers, authorization: humanReviewerAuthorization }, body: JSON.stringify({ requestId: randomUUID() }) });
  expect(approval.status).toBe(201);
  const promotion = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}/promotions`, {
    method: "POST", headers, body: JSON.stringify({ schemaVersion: 1 }) });
  expect(promotion.status, await promotion.text()).toBe(201);
  await until(() => received.some((entry) => externalWebhookEventSchema.parse(entry).type === "dev.dim.git.ref.promoted"));
  await closeFinalizeService(fixture.service);
  const restarted = await startFinalizeService(fixture.root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, config);
  status = 204;
  const retryRoute = `${restarted.origin}${route}/${target.id}/${createdEvent.id}/retry`;
  const requestId = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = await fetch(retryRoute, { method: "POST", headers, body: JSON.stringify({ requestId }) });
    expect(retry.status, await retry.text()).toBe(200);
  }
  await until(async () => JSON.stringify(await (await fetch(`${restarted.origin}${route}`, { headers })).json()).includes('"status":"delivered"'));
  await closeFinalizeService(restarted);
  const again = await startFinalizeService(fixture.root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, config);
  const replay = await fetch(`${again.origin}${route}/${target.id}/${createdEvent.id}/retry`, {
    method: "POST", headers, body: JSON.stringify({ requestId }) });
  expect(replay.status).toBe(200);
  expect(received.filter((entry) => externalWebhookEventSchema.parse(entry).id === createdEvent.id)).toHaveLength(2);
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-external-webhook-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function receiver(handle: (headers: IncomingHttpHeaders, body: string) => number): Promise<{ origin: string }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    response.writeHead(handle(request.headers, Buffer.concat(chunks).toString("utf8")));
    response.end();
  });
  return { origin: await listen(server) };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 7000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
