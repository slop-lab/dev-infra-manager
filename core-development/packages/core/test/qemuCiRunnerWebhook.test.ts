import { spawnSync } from "node:child_process";
import { afterEach, describe } from "vitest";
import { cleanupWebhookTests } from "./qemuCiRunnerWebhookHarness.js";
import { registerWebhookAdmissionScenarios } from "./qemuCiRunnerWebhookAdmissionScenarios.js";
import { registerWebhookCapacityScenarios } from "./qemuCiRunnerWebhookCapacityScenarios.js";
import { registerWebhookDurabilityScenarios } from "./qemuCiRunnerWebhookDurabilityScenarios.js";
import { registerWebhookFailureScenarios } from "./qemuCiRunnerWebhookFailureScenarios.js";
import { registerWebhookRecoveryScenarios } from "./qemuCiRunnerWebhookRecoveryScenarios.js";
import { registerWebhookShutdownScenarios } from "./qemuCiRunnerWebhookShutdownScenarios.js";
import { registerWebhookSupervisorScenarios } from "./qemuCiRunnerWebhookSupervisorScenarios.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

afterEach(cleanupWebhookTests);

describe.runIf(hasPython)("QEMU CI webhook event precedence", () => {
  registerWebhookAdmissionScenarios();
  registerWebhookCapacityScenarios();
  registerWebhookShutdownScenarios();
  registerWebhookFailureScenarios();
  registerWebhookRecoveryScenarios();
  registerWebhookSupervisorScenarios();
  registerWebhookDurabilityScenarios();
});
