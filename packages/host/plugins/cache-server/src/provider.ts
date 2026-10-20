import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { atomicWrite } from "@slop-lab/dim-host-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { ensureCacheServices, type CacheEndpoint } from "./cache-services.js";
import { selectCacheServices } from "./services/index.js";

/** Deployment stays here. Consumers receive URLs and have no deployment dependency. */
export async function ensureLocalCaches(runner: StreamingCommandRunner, stateRoot: string, kinds?: readonly string[]) {
  const services = selectCacheServices(kinds);
  const pins: unknown = JSON.parse(await readFile(new URL("./cache-images.json", import.meta.url), "utf8"));
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw new Error("invalid reviewed cache image pins");
  const definitions = services.map(({ kind, definition }) => {
    const image: unknown = Reflect.get(pins, kind);
    if (typeof image !== "string" || !image.includes("@sha256:")) throw new Error(`missing reviewed ${kind} cache image pin`);
    return definition(image);
  });
  const managed = await ensureCacheServices(runner, { stateRoot: join(stateRoot, "plugins/cache-server") }, definitions);
  const endpoints: Record<string, string> = {};
  for (const { kind, endpointUrl } of services) {
    const endpoint = managed[kind]; if (!endpoint) throw new Error(`cache '${kind}' is unavailable`);
    await listening(endpoint);
    endpoints[kind] = endpointUrl(endpoint);
  }
  await atomicWrite(join(stateRoot, "services/package-caches.json"), { schemaVersion: 1, endpoints });
  return endpoints;
}
async function listening(endpoint: CacheEndpoint): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect(endpoint.port, endpoint.host);
      socket.setTimeout(1_000);
      const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
      socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.once("timeout", () => finish(false));
    });
    if (ready) return;
    if (Date.now() >= deadline) throw new Error("cache service did not start; inspect its Docker logs");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
