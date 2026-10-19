import { UserError, type WorkspaceHostPlugin } from "@slop-lab/dim-host-core/workspace";
import { runCiWorker } from "./host.js";
import { buildNativeQemuRunnerImage } from "./nativeQemuRunnerImage.js";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "ci-worker",
  commands: [{ name: "ci", description: "Run trusted configured CI slots or build their VM supervisor image" }],
  async run(args, context) {
    const [command, action, value, ...extra] = args;
    if (command !== "ci" || !value || extra.length || !["worker", "qemu-image"].includes(action ?? "")) {
      throw new UserError("usage: dim ci worker CONFIG | dim ci qemu-image IMAGE");
    }
    if (action === "qemu-image") {
      await buildNativeQemuRunnerImage(context.runner, value, { signal: context.signal,
        reportProgress: (stage) => process.stderr.write(`${stage}\n`) });
      console.log(value); return;
    }
    await runCiWorker(value, context.signal, { runner: context.runner,
      ...(context.executionRouting === undefined ? {} : { routingProvider: () => context.executionRouting!() }) });
  }
};
export { runCiWorker } from "./host.js";
export { createSysboxBackend } from "./backends/sysbox.js";
export { createQemuBackend } from "./backends/qemu.js";
export { buildNativeQemuRunnerImage } from "./nativeQemuRunnerImage.js";
