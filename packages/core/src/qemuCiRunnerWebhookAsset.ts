import { QEMU_CI_WEBHOOK_BOOTSTRAP } from "./qemuCiRunnerWebhookBootstrapAsset.js";
import { QEMU_CI_WEBHOOK_HANDLER } from "./qemuCiRunnerWebhookHandlerAsset.js";
import { QEMU_CI_WEBHOOK_PRELUDE_STATE } from "./qemuCiRunnerWebhookPreludeStateAsset.js";
import { QEMU_CI_WEBHOOK_WORKER_SUPERVISOR } from "./qemuCiRunnerWebhookWorkerSupervisorAsset.js";

export const QEMU_CI_WEBHOOK_SCRIPT = [
  QEMU_CI_WEBHOOK_PRELUDE_STATE,
  QEMU_CI_WEBHOOK_WORKER_SUPERVISOR,
  QEMU_CI_WEBHOOK_HANDLER,
  QEMU_CI_WEBHOOK_BOOTSTRAP
].join("");
