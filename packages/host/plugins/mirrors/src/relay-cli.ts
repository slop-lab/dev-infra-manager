import { isDeepStrictEqual } from "node:util";
import { join, dirname } from "node:path";
import { atomicWrite, tryAcquireKernelGuard } from "@slop-lab/dim-host-core";
import { createMirrorRelay } from "./relay.js";
import { parseRelayConfig, privateJson } from "./relay-state.js";
async function main() {
  const file = process.argv[2]; if (!file) throw new Error("mirror relay requires private configuration");
  const config = parseRelayConfig(await privateJson(file)), root = dirname(file);
  let guard = await tryAcquireKernelGuard(join(root, "relay.guard"));
  for (let attempt = 0; !guard && attempt < 100; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20)); guard = await tryAcquireKernelGuard(join(root, "relay.guard"));
  }
  if (!guard) throw new Error("mirror relay is already running");
  try {
    const relay = await createMirrorRelay(config);
    await atomicWrite(join(root, "ready.json"), { configurationId: config.configurationId, ports: relay.ports, controlPort: relay.controlPort });
    let reloading = false;
    const timer = setInterval(() => {
      if (reloading) return; reloading = true;
      void (async () => {
        const next = parseRelayConfig(await privateJson(file));
        const { endpoints: _endpoints, configurationId: _id, ...scope } = config;
        const { endpoints: _nextEndpoints, configurationId: _nextId, ...nextScope } = next;
        if (!isDeepStrictEqual(scope, nextScope)) throw new Error("mirror relay scope changed");
        if (next.configurationId !== config.configurationId) {
          relay.updateTargets(next);
          await atomicWrite(join(root, "ready.json"), { configurationId: next.configurationId, ports: relay.ports, controlPort: relay.controlPort });
        }
      })().catch(() => relay.close()).finally(() => { reloading = false; });
    }, 250);
    const ownedGuard = guard;
    void relay.closed.then(async () => { clearInterval(timer); await ownedGuard.release(); });
    const close = async () => { await relay.close(); };
    process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
    // Discard closes both listeners; releasing the flock child then ends this process.
  } catch (error) { await guard.release(); throw error; }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "mirror relay failed"); process.exitCode = 1; });
