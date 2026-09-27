import { type Command } from "commander";
import { BUILTIN_CI_RUNNER_DEFAULTS, buildSharedQemuSchedulerImage, configuredCiRunnerDefaults, ProcessRunner, setConfiguredCiRunnerDefaults, UserError } from "@slop-lab/dim-core";
import {
  adminCall, adminStreamCall, ciExecutor, confirmAction, hasResourceFlags, print,
  printList, resourceInput, type JsonFlags, type ResourceFlags
} from "./cli-support.js";

export function registerCiCommands(program: Command): void {
  const ci = program.command("ci").description("Manage isolated CI execution");
const schedulerImage = ci.command("scheduler").description("Manage shared QEMU scheduler deployment assets")
  .command("image").description("Manage the shared QEMU scheduler image");
schedulerImage.command("build")
  .description("Build the separately deployed shared QEMU scheduler image")
  .argument("<image>", "explicit non-latest image tag")
  .action(async (image: string) => {
    await buildSharedQemuSchedulerImage(new ProcessRunner(), image);
    console.log(image);
  });
const ciRunner = ci.command("runner").description("Manage project CI runners");

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
