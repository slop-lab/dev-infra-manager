import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";
import type { CacheServiceDefinition, CacheServiceOptions } from "../../../../packages/host/plugins/cache-server/src/cache-services.js";
import { ensureLocalCaches } from "../../../../packages/host/plugins/cache-server/src/provider.js";

const { ensure } = vi.hoisted(() => ({ ensure: vi.fn<(runner: StreamingCommandRunner, options: CacheServiceOptions,
  definitions: readonly CacheServiceDefinition[]) => Promise<Record<string, { host: string; port: number }>>>() }));
vi.mock("../../../../packages/host/plugins/cache-server/src/cache-services.js", () => ({ ensureCacheServices: ensure }));
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const runner: StreamingCommandRunner = {
  async run() { throw new Error("provider must delegate Docker operations to the lifecycle"); },
  async runStreaming() { throw new Error("unexpected streaming operation"); }
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  ensure.mockReset();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-selected-cache-provider-")); roots.push(root);
  const server = createServer((socket) => socket.end()); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener has no port");
  ensure.mockImplementation(async (_runner, _options, definitions) => Object.fromEntries(definitions.map(({ name }) =>
    [name, { host: "127.0.0.1", port: address.port }])));
  return { root, origin: `http://127.0.0.1:${address.port}/` };
}
it("provisions only selected adapters and publishes their own protocol endpoint paths", async () => {
  const { root, origin } = await fixture();
  expect(await ensureLocalCaches(runner, root, ["npm", "pypi"])).toEqual({ npm: origin, pypi: `${origin}root/pypi/+simple/` });
  const definitions = ensure.mock.calls[0]?.[2];
  expect(definitions?.map(({ name }) => name)).toEqual(["npm", "pypi"]);
  expect(definitions?.every(({ image }) => /@sha256:[a-f0-9]{64}$/.test(image))).toBe(true);
  expect(JSON.parse(await readFile(join(root, "services/package-caches.json"), "utf8"))).toEqual({ schemaVersion: 1,
    endpoints: { npm: origin, pypi: `${origin}root/pypi/+simple/` } });
});
it("defaults to all services and republishes an explicit subset without reconciling unselected containers", async () => {
  const { root, origin } = await fixture();
  expect(Object.keys(await ensureLocalCaches(runner, root))).toEqual(["docker", "npm", "pypi", "apt"]);
  await ensureLocalCaches(runner, root, ["apt"]);
  expect(ensure.mock.calls[1]?.[2].map(({ name }) => name)).toEqual(["apt"]);
  expect(JSON.parse(await readFile(join(root, "services/package-caches.json"), "utf8"))).toEqual({ schemaVersion: 1, endpoints: { apt: origin } });
});
it.each([["unknown"], ["npm", "npm"], []])("rejects an invalid selection before provisioning: %j", async (...kinds) => {
  // Each table row is the selected list, including the deliberately empty list.
  const root = await mkdtemp(join(tmpdir(), "dim-invalid-cache-provider-")); roots.push(root);
  await expect(ensureLocalCaches(runner, root, kinds)).rejects.toThrow(/cache service/);
  expect(ensure).not.toHaveBeenCalled();
  await expect(readFile(join(root, "services/package-caches.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
