import { UserError } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { runHostExecutionWorker } from "./host.js";
import { buildNativeQemuRunnerImage } from "./nativeQemuRunnerImage.js";
import { executionTaskHandlers } from "@slop-lab/dim-contracts-execution/plugin-api";
import { createExecutionOperatorClient } from "@slop-lab/dim-service-client-execution";
import { enrollExecutionWorker, exportExecutionWorker } from "./enrollment.js";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "execution-worker",
  commands: [{ name: "execution", description: "Inspect execution services, run task/CI slots or build their VM supervisor image" }],
  async run(args, context) {
    const [command, action, value, ...extra] = args;
    if (command === "execution" && action === "console") {
      const { runExecutionConsole } = await import("./console.js");
      await runExecutionConsole(args.slice(2)); return;
    }
    if (command === "execution" && action === "worker" && value === "enroll") {
      const connection = option(extra, "--connection"), spec = option(extra, "--spec"), output = option(extra, "--output");
      if (connection === undefined || spec === undefined || output === undefined || extra.length !== 6) throw usage();
      await enrollExecutionWorker({ connectionFile: connection, specFile: spec, outputFile: output });
      console.log(output); return;
    }
    if (command === "execution" && action === "worker" && value === "export") {
      const connection = option(extra, "--connection"), spec = option(extra, "--spec"), output = option(extra, "--output");
      if (connection === undefined || spec === undefined || output === undefined || extra.length !== 6) throw usage();
      await exportExecutionWorker({ connectionFile: connection, specFile: spec, outputFile: output });
      console.log(output); return;
    }
    if (command === "execution" && action === "worker" && value === "discover") {
      const connection = option(extra, "--connection");
      if (connection === undefined || extra.length !== 3 || extra[2] !== "--json") throw usage();
      console.log(JSON.stringify(await (await createExecutionOperatorClient(connection)).workers())); return;
    }
    if (command !== "execution" || !value || extra.length || !["worker", "qemu-image"].includes(action ?? "")) {
      throw usage();
    }
    if (action === "qemu-image") {
      await buildNativeQemuRunnerImage(context.runner, value, { signal: context.signal,
        reportProgress: (stage) => process.stderr.write(`${stage}\n`) });
      console.log(value); return;
    }
    await runHostExecutionWorker(value, context.signal, workerOptions(context));
  }
};
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];
}
function usage(): UserError {
  return new UserError("usage: dim execution worker enroll --connection ABS --spec ABS --output ABS | dim execution worker export --connection ABS --spec ABS --output ABS | dim execution worker discover --connection ABS --json | dim execution worker CONFIG | dim execution qemu-image IMAGE");
}
function workerOptions(context: Parameters<NonNullable<WorkspaceHostPlugin["run"]>>[1]) {
  return { runner: context.runner, taskHandlers: executionTaskHandlers(context.extensions ?? []),
    ...(context.executionRouting === undefined ? {} : { routingProvider: () => context.executionRouting!() }) };
}
export { runHostExecutionWorker } from "./host.js";
export { createSysboxBackend } from "./backends/sysbox.js";
export { createQemuBackend } from "./backends/qemu.js";
export { buildNativeQemuRunnerImage } from "./nativeQemuRunnerImage.js";
