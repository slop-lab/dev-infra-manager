import { type Command } from "commander";
import {
  configuredWorkspaceBackend, inspectWorkspaceBackends, lifecycleOptionsForBackend,
  runCommonDoctorChecks, runDoctor, runtimeBackendChecks, setConfiguredWorkspaceBackend, UserError
} from "@slop-lab/dim-core";
import {
  adminCall, parseWorkspaceBackend, print, printDoctorChecks, runner,
  selectInstalledWorkspaceBackend, type JsonFlags
} from "./cli-support.js";

export function registerDoctorAndPluginCommands(program: Command): void {
  const doctor = program.command("doctor")
  .description("Check host and workspace runtime readiness")
  .action(async () => {
    const backend = configuredWorkspaceBackend();
    if (backend === undefined) {
      const checks = await runCommonDoctorChecks(runner);
      printDoctorChecks(checks);
      const detected = (await inspectWorkspaceBackends(runner))
        .filter((inspection) => inspection.ok)
        .map((inspection) => inspection.backend);
      console.log(
        `fail\tWorkspace backend configuration\t`
        + `${detected.length === 0 ? "no installed backend detected" : `detected: ${detected.join(", ")}`}; `
        + "run 'dim doctor configure-backend'"
      );
      process.exitCode = 1;
      return;
    }
    const checks = await runDoctor(runner, backend, lifecycleOptionsForBackend(backend));
    printDoctorChecks(checks);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

doctor.command("configure-backend")
  .description("Detect, verify, and record an installed workspace backend")
  .argument("[backend]", "sysbox")
  .action(async (backendArgument: string | undefined) => {
    const backend = backendArgument === undefined
      ? await selectInstalledWorkspaceBackend()
      : parseWorkspaceBackend(backendArgument);
    const checks = await runtimeBackendChecks(runner, backend, lifecycleOptionsForBackend(backend));
    printDoctorChecks(checks);
    if (checks.some((check) => !check.ok)) {
      throw new UserError(`workspace backend '${backend}' is not installed and ready`);
    }
    const target = await setConfiguredWorkspaceBackend(backend);
    console.log(`Configured workspace backend '${backend}' in ${target}`);
  });

const plugin = program.command("plugin").description("Inspect installed DIM plugins");
plugin.command("list").option("--json", "print machine-readable JSON").action(async (flags: JsonFlags) => {
  print(await adminCall<Record<string, unknown>>("plugin.list"), flags);
});
}
