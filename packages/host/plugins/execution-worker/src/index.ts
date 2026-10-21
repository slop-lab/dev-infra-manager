import { UserError } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { runHostExecutionWorker } from "./host.js";
import { buildNativeQemuRunnerImage } from "./nativeQemuRunnerImage.js";
import { executionTaskHandlers } from "@slop-lab/dim-contracts-execution/plugin-api";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "execution-worker",
  commands: [{ name: "execution", description: "Run configured task and CI slots or build their VM supervisor image" }],
  async run(args, context) {
    const [command, action, value, ...extra] = args;
    if (command !== "execution" || !value || extra.length || !["worker", "qemu-image"].includes(action ?? "")) {
      throw new UserError("usage: dim execution worker CONFIG | dim execution qemu-image IMAGE");
    }
    if (action === "qemu-image") {
      await buildNativeQemuRunnerImage(context.runner, value, { signal: context.signal,
        reportProgress: (stage) => process.stderr.write(`${stage}\n`) });
      console.log(value); return;
    }
    await runHostExecutionWorker(value, context.signal, { runner: context.runner, taskHandlers: executionTaskHandlers(context.extensions ?? []),
      ...(context.executionRouting === undefined ? {} : { routingProvider: () => context.executionRouting!() }) });
  }
};
export { runHostExecutionWorker } from "./host.js";
export { createSysboxBackend } from "./backends/sysbox.js";
export { createQemuBackend } from "./backends/qemu.js";
export { buildNativeQemuRunnerImage } from "./nativeQemuRunnerImage.js";
