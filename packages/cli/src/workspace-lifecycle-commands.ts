import { type Command } from "commander";
import { lifecycleOptions, UserError } from "@slop-lab/dim-core";
import {
  adminCall, adminStreamCall, collect, confirmAction, ensureManagedController,
  externalUrlControllerRequest, printActionResult, stopManagedController, type JsonFlags
} from "./cli-support.js";

export function registerWorkspaceLifecycleCommands(workspace: Command): void {
  workspace.command("align")
  .description("Align the root checkout to its configured ref without running setup")
  .argument("<workspace>")
  .option("--reset", "reset the configured local branch to the fetched ref")
  .option("--yes", "confirm resetting local commits on the configured branch")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags & { reset?: boolean; yes?: boolean }) => {
    if (flags.reset) {
      await confirmAction(flags.yes ?? false, `Discard local commits in workspace '${name}'?`);
    }
    const result = await adminStreamCall("workspace.align", { name, reset: flags.reset ?? false });
    printActionResult(result, flags, `Aligned workspace '${name}'`);
  });

workspace.command("setup")
  .description("Retry root project environment setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    const result = await adminStreamCall("workspace.setup", { name });
    printActionResult(result, flags, `Workspace '${name}' is ready`);
  });

workspace.command("update")
  .description("Fast-forward the root ref and run setup")
  .argument("<workspace>")
  .option("--profile <profile>", "replace Compose capability profiles", collect, [])
  .option("--clear-profiles", "remove all capability profiles")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: { profile: string[]; clearProfiles?: boolean; json?: boolean }) => {
    if (flags.clearProfiles && flags.profile.length > 0) {
      throw new UserError("--clear-profiles cannot be combined with --profile");
    }
    const options = lifecycleOptions();
    await ensureManagedController(options);
    const result = await adminStreamCall("workspace.update", {
      name,
      ...(flags.clearProfiles ? { profiles: [] } : flags.profile.length > 0 ? { profiles: flags.profile } : {})
    });
    printActionResult(result, flags, `Updated workspace '${name}'`);
  });

workspace.command("start")
  .description("Start a stopped workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    const result = await adminStreamCall("workspace.start", { name });
    printActionResult(result, flags, `Started workspace '${name}'`);
  });

workspace.command("restart")
  .description("Restart a workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    const result = await adminStreamCall("workspace.restart", { name });
    printActionResult(result, flags, `Restarted workspace '${name}'`);
  });

workspace.command("stop")
  .description("Stop a workspace while preserving its checkout and inner-engine data")
  .argument("<workspace>")
  .action(async (name: string) => void await adminStreamCall("workspace.stop", { name }));

workspace.command("discard")
  .description("Permanently delete a workspace container and unpushed changes")
  .argument("<workspace>")
  .option("--yes", "confirm permanent deletion")
  .option("--keep-volume", "retain DIM-managed nested-engine data for recreation with the same name")
  .action(async (name: string, flags: { yes?: boolean; keepVolume?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently discard workspace '${name}'?`);
    const options = lifecycleOptions();
    await ensureManagedController(options);
    await externalUrlControllerRequest("/api/urls", { method: "DELETE" }, name).catch((error) => {
      if (!(error instanceof Error) || !error.message.includes("(404)")) throw error;
    });
    await adminStreamCall("workspace.discard", { name, keepVolume: flags.keepVolume ?? false });
    if ((await adminCall<unknown[]>("workspace.list")).length === 0) await stopManagedController(options);
  });
}
