import { type Command } from "commander";
import { detectWorkspaceKvm, inspectWorkspaceImage, lifecycleOptions, UserError } from "@slop-lab/dim-core";
import {
  adminCall, adminStreamCall, collect, confirmRecommended, ensureManagedController,
  hasResourceFlags, interactive, print, printActionResult, printList, resourceInput, runner,
  workspaceLifecycleStreamCall, type JsonFlags, type ResourceFlags, type WorkspaceCreateFlags
} from "./cli-support.js";

export function registerWorkspaceCommands(program: Command): Command {
  const workspace = program.command("workspace").description("Manage persistent development workspaces");

const workspaceImage = workspace.command("image").description("Inspect the configured workspace image");

workspaceImage.command("status")
  .description("Show whether the configured workspace image is available")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const options = lifecycleOptions();
    const result = await inspectWorkspaceImage(runner, options.defaultWorkspaceBackend, options);
    if (flags.json) {
      console.log(JSON.stringify(result));
      return;
    }
    switch (result.status) {
      case "ready":
        console.log(`Workspace image is ready: ${result.imageId}`);
        return;
      case "missing":
        console.log("Workspace image is missing");
        return;
      default:
        result satisfies never;
    }
  });

workspace.command("create")
  .description("Create a persistent workspace for a project")
  .argument("<project>")
  .argument("<workspace>")
  .option("--profile <profile>", "Compose capability profile", collect, [])
  .option("--require-capability <name>", "require an installed plugin provider", collect, [])
  .option("--recommend-capability <name>", "use an installed plugin provider when available", collect, [])
  .option("--repo-ref <alias=ref>", "candidate checkout ref for a non-root repository", collect, [])
  .option("--git-user-name <name>")
  .option("--git-user-email <email>")
  .option("--cpus <count>", "workspace CPU limit")
  .option("--memory <size>", "workspace memory limit")
  .option("--pids <count>", "workspace PID limit")
  .option("--kvm", "allow available host KVM access")
  .option("--no-kvm", "do not pass host KVM into the workspace")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, name: string, flags: WorkspaceCreateFlags) => {
    const options = lifecycleOptions();
    const availableKvm = await detectWorkspaceKvm(options.defaultWorkspaceBackend);
    let kvm: boolean | undefined;
    if (flags.kvm !== undefined) kvm = flags.kvm;
    else if (availableKvm && interactive()) {
      kvm = await confirmRecommended(
        "Allow this trusted workspace to access host KVM? Recommended for VM-backed development and verification."
      );
    }
    await ensureManagedController(options);
    const result = await workspaceLifecycleStreamCall("workspace.create", {
      project: projectName,
      name,
      profiles: flags.profile,
      requiredCapabilities: flags.requireCapability,
      recommendedCapabilities: flags.recommendCapability,
      repositoryRefs: flags.repoRef,
      runtimeBackend: options.defaultWorkspaceBackend,
      cpuCount: flags.cpus ?? options.cpuCount,
      memory: flags.memory ?? options.memory,
      pidsLimit: flags.pids ?? options.pidsLimit,
      ...(kvm === undefined ? {} : { kvm }),
      ...(flags.gitUserName ? { gitUserName: flags.gitUserName } : {}),
      ...(flags.gitUserEmail ? { gitUserEmail: flags.gitUserEmail } : {})
    });
    printActionResult(result, flags, `Workspace '${name}' is ready`);
  });

workspace.command("list")
  .alias("ls")
  .description("List workspaces")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(
      await adminCall<Record<string, unknown>[]>("workspace.list"),
      ["name", "projectName", "phase", "runtimeBackend", "rootRef"],
      flags
    )
  );

workspace.command("show")
  .description("Show a workspace")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await adminCall("workspace.show", { name }), flags));

workspace.command("resources")
  .description("Update resource limits for an existing workspace")
  .argument("<workspace>")
  .option("--cpus <count>", "workspace CPU limit")
  .option("--memory <size>", "workspace memory limit")
  .option("--pids <count>", "workspace PID limit")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: ResourceFlags & JsonFlags) => {
    if (!hasResourceFlags(flags)) throw new UserError("provide at least one resource limit");
    const options = lifecycleOptions();
    await ensureManagedController(options);
    const result = await adminStreamCall("workspace.resources", {
      name,
      ...(flags.cpus === undefined ? {} : { cpuCount: flags.cpus }),
      ...(flags.memory === undefined ? {} : { memory: flags.memory }),
      ...(flags.pids === undefined ? {} : { pidsLimit: flags.pids })
    });
    printActionResult(result, flags, `Updated resources for workspace '${name}'`);
  });
  return workspace;
}
