import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MergeAuthorizationStore, promoteInstalledNativeReview, controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-merge-policy";
import { startWebhookService, webhookConfigurationSchema } from "@slop-lab/dim-control-plane-plugin-webhooks";
import { webhookEventSources } from "@slop-lab/dim-control-plane-plugin-webhooks/plugin-api";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { fixture, git, basic, reviewer, token, generationId, record, text } from "../git-repositories/optionalFeaturesFixture.js";
const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
const foreignPromoter = { hostId: "host-b", username: "foreign-promoter", password: token(11) };
const headers = (credential: { username: string; password: string } = promoter) => ({ authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId });
async function reviewedFixture() {
  const merge = await mergePlugin.configure({ hostPromoters: [promoter, foreignPromoter] });
  const f = await fixture(true, merge.extensions ?? []);
  try {
    await writeFile(join(f.source, "README.md"), "reviewed proposal\n"); const candidate = await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const resolved = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/resolve`, { method: "POST", headers: headers(reviewer), body: JSON.stringify({ schemaVersion: 1, proposalRef: f.proposalRef }) });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const reviewId = text(record(record(await resolved.json()).review), "reviewId");
    return { ...f, candidate, reviewId, merge, path: `/v1/projects/project/repositories/main/reviews/${reviewId}` };
  } catch (error) { await f.service.close(); await rm(f.root, { recursive: true, force: true }); throw error; }
}
async function approve(f: Awaited<ReturnType<typeof reviewedFixture>>) {
  const response = await fetch(`${f.origin}${f.path}/approvals`, { method: "POST", headers: headers(reviewer), body: JSON.stringify({ requestId: randomUUID() }) });
  expect(response.status, await response.clone().text()).toBe(201);
}
async function promote(f: Awaited<ReturnType<typeof reviewedFixture>>, credential: { username: string; password: string } = promoter, generation = generationId) {
  return fetch(`${f.origin}${f.path}/promotions`, { method: "POST", headers: { ...headers(credential), "x-dim-generation-id": generation }, body: JSON.stringify({ schemaVersion: 1 }) });
}
async function head(f: Awaited<ReturnType<typeof reviewedFixture>>) {
  return (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim();
}
it("promotes one approved Git transition under concurrent HTTP requests without any CI installation", async () => {
  const f = await reviewedFixture();
  try {
    expect((await promote(f)).status).toBe(409); expect(await head(f)).toBe(f.initial);
    await approve(f);
    const responses = await Promise.all([promote(f), promote(f)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
    expect(await head(f)).toBe(f.candidate);
    const outcomes = await Promise.all(responses.map(async (response) => record(await response.json())));
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["already-current", "promoted"]);
    expect(outcomes.map(({ sequence }) => sequence)).toEqual([1, 1]);
    expect((await readFile(join(f.root, "state/.extensions/merge-policy/authorizations.sqlite3"))).length).toBeGreaterThan(0);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
it("denies foreign roles, hosts, generations and a proposal changed after approval", async () => {
  const f = await reviewedFixture();
  try {
    await approve(f);
    expect((await promote(f, reviewer)).status).toBe(403);
    expect((await promote(f, foreignPromoter)).status).toBe(404);
    expect((await promote(f, promoter, "b".repeat(64))).status).toBe(409);
    await writeFile(join(f.source, "README.md"), "changed after approval\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    expect((await promote(f)).status).toBe(409); expect(await head(f)).toBe(f.initial);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
it("backfills independent review and promotion webhook transport from durable producer state", async () => {
  const f = await reviewedFixture();
  const received: { type: string; id: string }[] = [];
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = record(JSON.parse(Buffer.concat(chunks).toString()));
    received.push({ type: text(value, "type"), id: text(value, "id") }); response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address(); if (!address || typeof address === "string") throw new Error("receiver missing");
  let transport: Awaited<ReturnType<typeof startWebhookService>> | undefined;
  try {
    await approve(f); expect((await promote(f)).status).toBe(201);
    const config = webhookConfigurationSchema.parse({ schemaVersion: 1, stateDirectory: join(f.root, "webhooks"), generationId,
      sources: ["code-review", "merge-policy"], subscribers: [{ id: "audit", endpoint: `http://127.0.0.1:${address.port}`, secret: `whsec_${Buffer.alloc(32, 19).toString("base64")}`, projects: ["project"], events: ["dev.dim.git.review.created", "dev.dim.git.ref.promoted"] }], operators: [{ username: "auditor", password: token(12), projects: ["project"] }], listen: { host: "127.0.0.1", port: 0 } });
    const sources = webhookEventSources(f.extensions);
    transport = await startWebhookService(config, sources, new AbortController().signal);
    await until(() => received.length === 2);
    expect(received.map(({ type }) => type).sort()).toEqual(["dev.dim.git.ref.promoted", "dev.dim.git.review.created"]);
    const ids = received.map(({ id }) => id).sort();
    await transport.close(); transport = await startWebhookService(config, sources, new AbortController().signal);
    await until(() => transport?.dispatcher.store.list("project").length === 2);
    expect(transport.dispatcher.store.list("project").map(({ eventId }) => eventId).sort()).toEqual(ids);
    expect(transport.dispatcher.store.list("project").every(({ status }) => status === "delivered")).toBe(true);
    expect(received).toHaveLength(2);
  } finally { await transport?.close(); receiver.closeAllConnections(); await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve())); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
it.each(["afterIntent", "afterCompareAndSwap"] as const)("recovers only accepted CAS receipts after interruption at %s", async (interruption) => {
  const f = await reviewedFixture();
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    await approve(f);
    const store = new MergeAuthorizationStore(join(f.root, "state/.extensions/merge-policy/authorizations.sqlite3"));
    try {
      await expect(f.service.context.serialize(() => promoteInstalledNativeReview({ repository: f.service.context, store, guards: [],
        hooks: { [interruption]: () => { throw new Error("simulated process interruption"); } } }, "project", "main", f.reviewId))).rejects.toThrow(/simulated process interruption/);
      expect(store.read()[0]?.sequence).toBeUndefined();
    } finally { store.close(); }
    expect(await head(f)).toBe(interruption === "afterIntent" ? f.initial : f.candidate);
    await f.service.close();
    restarted = await configuredNativeGitBundleServer(f.options);
    const origin = await restarted.listen("127.0.0.1", 0);
    const source = webhookEventSources(f.extensions).find(({ name }) => name === "merge-policy");
    expect((await source?.read())?.length).toBe(interruption === "afterIntent" ? 0 : 1);
    const promoted = await fetch(`${origin}${f.path}/promotions`, { method: "POST", headers: headers(), body: JSON.stringify({ schemaVersion: 1 }) });
    expect(promoted.status, await promoted.clone().text()).toBe(interruption === "afterIntent" ? 201 : 200);
    expect(record(await promoted.json()).sequence).toBe(1);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
async function until(condition: () => boolean) { const deadline = Date.now() + 4000; while (!condition()) { if (Date.now() > deadline) throw new Error("webhook delivery deadline"); await new Promise((resolve) => setTimeout(resolve, 20)); } }
