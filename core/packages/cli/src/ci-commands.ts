import { type Command } from "commander";
import {
  buildNativeQemuSchedulerImage,
  buildNativeQemuRunnerImage,
  queryNativeQemuEvent,
  ProcessRunner,
  lifecycleOptions,
  loadInstalledPlugins,
  resolveHostMirrorProvider,
  resolvePluginHome,
  runNativeRootCiHost,
  runNativeQemuHost,
  configuredNativeQemuSchedulerServer,
  loadNativeQemuSchedulerConfig
} from "@slop-lab/dim-core";

export function registerCiCommands(program: Command): void {
  const ci = program.command("ci").description("Manage isolated CI execution");
  const nativeQemu = ci.command("native-qemu").description("Manage Gitea-free native QEMU capacity");
  const nativeQemuScheduler = nativeQemu.command("scheduler").description("Manage the native QEMU scheduler");
  nativeQemuScheduler.command("run")
    .description("Run the native QEMU scheduler from a private operator config")
    .argument("<config>")
    .action(async (configPath: string) => {
      const config = await loadNativeQemuSchedulerConfig(configPath);
      const server = configuredNativeQemuSchedulerServer(config);
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(config.port, config.host, resolve);
        });
        await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
  nativeQemuScheduler.command("image").description("Manage the native QEMU scheduler image")
    .command("build").description("Build the independently deployed native QEMU scheduler image")
    .argument("<image>").action(async (image: string) => {
      await buildNativeQemuSchedulerImage(new ProcessRunner(), image);
      console.log(image);
    });
  nativeQemu.command("runner").description("Manage the trusted native QEMU runner image")
    .command("image").description("Manage the trusted native QEMU runner image")
    .command("build").description("Build the KVM runner image and fixed guest launcher")
    .argument("<image>").action(async (image: string) => {
      await buildNativeQemuRunnerImage(new ProcessRunner(), image);
      console.log(image);
    });
  nativeQemu.command("host").description("Run trusted native QEMU host capacity").command("run")
    .description("Run fixed KVM capacities from a private host connection")
    .argument("<host-id>").argument("<connection>")
    .action(async (hostId: string, connection: string) => {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try { await runNativeQemuHost(hostId, connection, abort.signal); }
      finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
  nativeQemu.command("event").description("Inspect durable native QEMU review demand")
    .command("status").description("Show one review event, claim, attempt, and terminal result")
    .argument("<event-id>").argument("<scheduler-config>")
    .action(async (eventId: string, config: string) => {
      console.log(JSON.stringify(await queryNativeQemuEvent(eventId, config)));
    });
  ci.command("native-root").description("Manage native root ordinary CI")
    .command("host").description("Run native root CI host capacity")
    .command("run")
    .description("Run fixed Sysbox capacities from a private host config")
    .argument("<config>")
    .action(async (config: string) => {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const loaded = await loadInstalledPlugins(await resolvePluginHome());
      try {
        const options = lifecycleOptions();
        const hostMirrorProvider = resolveHostMirrorProvider(loaded.registered.host);
        const runtimeOptions = hostMirrorProvider === undefined ? options : { ...options, hostMirrorProvider };
        await runNativeRootCiHost(config, abort.signal, runtimeOptions);
      }
      finally {
        await loaded.registered.dispose();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
}
