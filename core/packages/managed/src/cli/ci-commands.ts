import type { Command } from "commander";
import { ProcessRunner } from "@slop-lab/dim-core";
import { loadInstalledPlugins, resolvePluginHome } from "../pluginLoader.js";
import { resolveHostMirrorProvider } from "../hostMirrorProvider.js";
import { lifecycleOptions } from "../lifecycleOptions.js";
import { runCiWorker } from "../ci/host.js";
import { buildNativeQemuRunnerImage } from "../nativeQemuRunnerImage.js";
export function registerCiCommands(program: Command): void {
  const ci = program.command("ci").description("Run isolated candidate jobs");
  ci.command("worker").description("Run configured Sysbox and QEMU slots from a private host config")
    .argument("<config>").action(async (config: string) => {
      const stop = new AbortController(), shutdown = () => stop.abort();
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
      const loaded = await loadInstalledPlugins(await resolvePluginHome());
      try {
        const provider = resolveHostMirrorProvider(loaded.registered.host);
        await runCiWorker(config, stop.signal, { lifecycle: { ...lifecycleOptions(),
          ...(provider === undefined ? {} : { hostMirrorProvider: provider }) } });
      }
      finally { await loaded.registered.dispose(); process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); }
    });
  ci.command("qemu-image").description("Build the trusted KVM supervisor and fixed guest launcher")
    .argument("<image>").action(async (image: string) => {
      await buildNativeQemuRunnerImage(new ProcessRunner(), image); console.log(image);
    });
}
