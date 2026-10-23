import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMergePolicyCli } from "../../../../packages/control-plane/plugins/git-merge-policy/src/cli.js";

async function fixture(identity: { hostId?: string; generationId?: string } = {}) {
  const generationId = "a".repeat(64), requests: { method: string | undefined; path: string | undefined; generation: unknown }[] = [];
  const root = await mkdtemp(join(tmpdir(), "dim-merge-cli-"));
  const credential = { username: "operator-promoter", password: "private".repeat(8) };
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
    requests.push({ method: request.method, path: request.url, generation: request.headers["x-dim-generation-id"] });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.method === "GET" ? { schemaVersion: 1, serviceId: "native-main", role: "host-promoter",
      hostId: identity.hostId ?? "host-a", generationId: identity.generationId ?? generationId } : { schemaVersion: 1, outcome: "promoted" }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("listener unavailable");
  const file = join(root, "promoter.json");
  // Exactly the connection shape written by control-plane connect.
  await writeFile(file, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: `http://127.0.0.1:${address.port}`,
    role: "host-promoter", hostId: "host-a", generationId, credential }), { mode: 0o600 });
  return { file, requests, generationId, async close() {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

describe("merge-policy operator CLI", () => {
  it("uses the generated promoter connection and attests before a generation-bound promotion", async () => {
    const env = await fixture();
    try {
      expect(JSON.parse(await runMergePolicyCli(["promote", env.file, "project-a", "public", "b".repeat(64)]))).toEqual({ schemaVersion: 1, outcome: "promoted" });
      expect(env.requests).toEqual([
        { method: "GET", path: "/v1/host-promoter-identity", generation: env.generationId },
        { method: "POST", path: `/v1/projects/project-a/repositories/public/reviews/${"b".repeat(64)}/promotions`, generation: env.generationId }
      ]);
    } finally { await env.close(); }
  });
  it.each([{ hostId: "another-host" }, { generationId: "c".repeat(64) }])("refuses a changed operator identity before promotion: %j", async (identity) => {
    const env = await fixture(identity);
    try {
      await expect(runMergePolicyCli(["promote", env.file, "project-a", "public", "b".repeat(64)])).rejects.toThrow(/identity or generation/);
      expect(env.requests.map(({ method }) => method)).toEqual(["GET"]);
    } finally { await env.close(); }
  });
  it("rejects an exposed connection before sending credentials", async () => {
    const env = await fixture();
    try {
      await chmod(env.file, 0o644);
      await expect(runMergePolicyCli(["promote", env.file, "project-a", "public", "b".repeat(64)])).rejects.toThrow(/mode-0600/);
      expect(env.requests).toEqual([]);
    } finally { await env.close(); }
  });
});
