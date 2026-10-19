import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { controlPlanePlugin } from "../../../../packages/control-plane/plugins/ci/src/index.js";

const credential = (name: string, value: number) => ({ username: name, password: Buffer.alloc(32, value).toString("base64url") });
const generation = "a".repeat(64), readinessToken = "r".repeat(43), activationToken = "a".repeat(43);
function serviceConfig() {
  return { schemaVersion: 1, claimLeaseMilliseconds: 30_000,
    nativeGit: { endpoint: "http://native-git:8080", grantIssuer: credential("grants", 1), candidateReader: credential("reader", 2), resultReporter: credential("results", 3) },
    credentials: { webhook: credential("webhook", 4), query: credential("query", 5), operator: credential("operator", 6) }, workers: [] };
}
it("starts a generation-gated coordinator through its control-plane descriptor and closes its listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-plugin-")), probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config = serviceConfig(), prepared = await controlPlanePlugin.configure({ service: config, stateDirectory: root,
    readinessToken, activationToken, expectedGenerationId: generation, listen: { host: "127.0.0.1", port: address.port } });
  const running = await prepared.start({ signal: new AbortController().signal });
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    expect((await fetch(origin + "/readyz", { headers: { authorization: `Bearer ${readinessToken}` } })).status).toBe(200);
    expect((await fetch(origin + "/v1/jobs")).status).toBe(503);
    const activation = await fetch(origin + "/v1/activation", { method: "POST", headers: { authorization: `Bearer ${activationToken}` }, body: JSON.stringify({ schemaVersion: 1, generationId: generation }) });
    expect(activation.status).toBe(200);
    const jobs = await fetch(origin + "/v1/jobs", { headers: { authorization: `Basic ${Buffer.from(`${config.credentials.query.username}:${config.credentials.query.password}`).toString("base64")}`, "x-dim-generation-id": generation } });
    expect(jobs.status).toBe(200); expect(await jobs.json()).toEqual([]);
  } finally { await running.close(); await rm(root, { recursive: true, force: true }); }
  const replacement = createServer(); await new Promise<void>((resolve) => replacement.listen(address.port, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => replacement.close(() => resolve()));
});
it("does not create execution state when startup is already cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-plugin-cancel-")), stateDirectory = join(root, "state");
  try {
    const prepared = await controlPlanePlugin.configure({ service: serviceConfig(), stateDirectory,
      readinessToken, activationToken, expectedGenerationId: generation });
    await expect(prepared.start({ signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(stat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
