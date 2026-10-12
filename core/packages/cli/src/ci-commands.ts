import { type Command } from "commander";
import {
  BUILTIN_CI_RUNNER_DEFAULTS,
  buildSharedQemuSchedulerImage,
  buildNativeQemuSchedulerImage,
  buildNativeQemuRunnerImage,
  queryNativeQemuEvent,
  configuredCiRunnerDefaults,
  lifecycleOptions,
  ProcessRunner,
  reconcileOrdinaryCiPoolProject,
  runOrdinaryCiPoolService,
  runNativeRootCiHost,
  runNativeQemuHost,
  configuredNativeQemuSchedulerServer,
  loadNativeQemuSchedulerConfig,
  setConfiguredCiRunnerDefaults,
  UserError
} from "@slop-lab/dim-core";
import {
  adminCall, adminStreamCall, ciExecutor, confirmAction, hasResourceFlags, print,
  printList, resourceInput, withLocalProgress, type JsonFlags, type ResourceFlags
} from "./cli-support.js";

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
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.listen(config.port, config.host, resolve);
      });
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
    }
  });
nativeQemuScheduler.command("image").description("Manage the native QEMU scheduler image")
  .command("build").description("Build the independently deployed native QEMU scheduler image")
  .argument("<image>").action(async (image: string) => {
    await buildNativeQemuSchedulerImage(new ProcessRunner(), image); console.log(image);
  });
nativeQemu.command("runner").description("Manage the trusted native QEMU runner image")
  .command("image").description("Manage the trusted native QEMU runner image")
  .command("build").description("Build the KVM runner image and fixed guest launcher")
  .argument("<image>").action(async (image: string) => {
    await buildNativeQemuRunnerImage(new ProcessRunner(), image); console.log(image);
  });
nativeQemu.command("host").description("Run trusted native QEMU host capacity").command("run")
  .description("Run fixed KVM capacities from a private host connection")
  .argument("<host-id>").argument("<connection>")
  .action(async (hostId: string, connection: string) => {
    const abort = new AbortController(); const stop = () => abort.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await runNativeQemuHost(hostId, connection, abort.signal); }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  });
nativeQemu.command("event").description("Inspect durable native QEMU review demand")
  .command("status").description("Show one review event, claim, attempt, and terminal result")
  .argument("<event-id>").argument("<scheduler-config>")
  .action(async (eventId: string, config: string) => {
    console.log(JSON.stringify(await queryNativeQemuEvent(eventId, config)));
  });
const nativeRoot = ci.command("native-root").description("Manage native root ordinary CI");
const nativeRootHost = nativeRoot.command("host").description("Run native root CI host capacity");
nativeRootHost.command("run")
  .description("Run fixed Sysbox capacities from a private host config")
  .argument("<config>")
  .action(async (config: string) => {
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try { await runNativeRootCiHost(config, abort.signal); }
    finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
const schedulerImage = ci.command("scheduler").description("Manage shared QEMU scheduler deployment assets")
  .command("image").description("Manage the shared QEMU scheduler image");
schedulerImage.command("build")
  .description("Build the separately deployed shared QEMU scheduler image")
  .argument("<image>", "explicit non-latest image tag")
  .action(async (image: string) => {
    await withLocalProgress("image.qemu-scheduler.build", ({ signal, reportProgress }) =>
      buildSharedQemuSchedulerImage(new ProcessRunner(), image, { signal, reportProgress }));
    console.log(image);
  });
const ciRunner = ci.command("runner").description("Manage project CI runners");
const ordinaryPool = ci.command("ordinary-pool").description("Manage host-scoped ordinary CI capacity");
const ordinaryProject = ordinaryPool.command("project").description("Reconcile reviewed Project admission");
ordinaryProject.command("reconcile")
  .description("Admit one Project from its protected root and reconcile its Gitea webhook")
  .argument("<project>")
  .argument("<registrar-config>")
  .action(async (projectName: string, registrarFile: string) => {
    const result = await reconcileOrdinaryCiPoolProject(new ProcessRunner(), lifecycleOptions(), {
      projectName,
      registrarFile
    });
    console.log(JSON.stringify(result));
  });
const ordinaryService = ordinaryPool.command("service").description("Run the ordinary CI control plane");
ordinaryService.command("run")
  .description("Run the ordinary CI control plane from a private reviewed config")
  .argument("<config>")
  .action(async (config: string) => {
    if (process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE !== undefined
      || process.env.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE !== undefined
      || process.env.DIM_NATIVE_QEMU_CONNECTION_FILE !== undefined) {
      throw new UserError("native Project and QEMU adapters are unavailable; refusing Gitea fallback");
    }
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try { await runOrdinaryCiPoolService(config, abort.signal); }
    finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
ciRunner.command("create")
  .description("Create a named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .argument("<executor>", "sysbox or qemu")
  .option("--cpus <count>")
  .option("--memory <size>")
  .option("--pids <count>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, executor: string, flags: ResourceFlags & JsonFlags) => {
    executor = ciExecutor(executor);
    if (executor === "qemu" && flags.pids !== undefined) throw new UserError("--pids applies only to the sysbox executor");
    print(await adminStreamCall("ci.runner.create", {
      project, name, executor,
      ...(hasResourceFlags(flags) ? { resources: resourceInput(flags) } : {})
    }), flags);
  });

ciRunner.command("list")
  .alias("ls")
  .description("List managed CI runners")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const records = await adminCall<Array<Record<string, unknown> & {
      executor: { kind: string; phase: string };
    }>>("ci.runner.list");
    if (flags.json) {
      print(records, flags);
      return;
    }
    printList(records.map((record) => ({
      projectName: record.projectName,
      name: record.name,
      executor: record.executor.kind,
      phase: record.executor.phase,
      provider: record.provider
    })), ["projectName", "name", "executor", "phase", "provider"]);
  });

ciRunner.command("status")
  .description("Show a named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminCall("ci.runner.show", { project, name }), flags)
  );

ciRunner.command("restart")
  .description("Reconcile and restart a named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminStreamCall("ci.runner.restart", { project, name }), flags));

ciRunner.command("start")
  .description("Start a stopped named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminStreamCall("ci.runner.start", { project, name }), flags));

ciRunner.command("stop")
  .description("Stop a named CI runner without deleting its local data")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminStreamCall("ci.runner.stop", { project, name }), flags)
  );

ciRunner.command("logs")
  .description("Follow project CI runner logs")
  .argument("<project>")
  .argument("<runner>")
  .action(async (project: string, name: string) => {
    const result = await adminStreamCall<{ exitCode: number }>("ci.runner.logs", { project, name });
    process.exitCode = result.exitCode;
  });

ciRunner.command("delete")
  .description("Remove a named CI runner and its local data")
  .argument("<project>")
  .argument("<runner>")
  .option("--yes", "confirm runner and local data deletion")
  .action(async (project: string, name: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete CI runner '${project}/${name}' and its local data?`);
    await adminStreamCall("ci.runner.delete", { project, name });
  });

const ciDefaults = ciRunner.command("defaults").description("Manage inherited CI runner resource defaults");

ciDefaults.command("show")
  .option("--json", "print machine-readable JSON")
  .action((flags: JsonFlags) => {
    const configured = configuredCiRunnerDefaults();
    print({
      resources: configured ?? BUILTIN_CI_RUNNER_DEFAULTS,
      source: configured ? "configured" : "builtin"
    }, flags);
  });

ciDefaults.command("set")
  .requiredOption("--cpus <count>")
  .requiredOption("--memory <size>")
  .requiredOption("--pids <count>")
  .action(async (flags: Required<ResourceFlags>) => {
    console.log(await setConfiguredCiRunnerDefaults(resourceInput(flags) as Required<ReturnType<typeof resourceInput>>));
  });

ciDefaults.command("reset")
  .action(async () => {
    console.log(await setConfiguredCiRunnerDefaults(undefined));
  });
}
