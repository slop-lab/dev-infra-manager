#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import {
  applyProjectRepositoryProtection,
  createProject,
  createProjectRepository,
  createWorkspace,
  discardWorkspace,
  ensureGitea,
  execWorkspace,
  importProjectRepository,
  lifecycleOptions,
  listProjectRepositories,
  listProjects,
  listWorkspaces,
  loadInstalledPlugins,
  ProcessRunner,
  projectRepositoryHostUrl,
  projectRepositoryWorkspaceUrl,
  purgeProject,
  removeProject,
  resolvePluginHome,
  restartWorkspace,
  runDoctor,
  runWorkspace,
  setupWorkspace,
  showProject,
  showProjectRepository,
  showWorkspace,
  startWorkspace,
  stopWorkspace,
  updateWorkspace,
  UserError,
  workspaceBackend
} from "@slop-lab/dev-infra-manager-core";

const runner = new ProcessRunner();
const program = new Command();

program
  .name("dim")
  .description("Isolated, persistent development workspaces")
  .version("0.2.0")
  .option("--json", "print machine-readable JSON")
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("after", `
Typical flow:
  dim project create PROJECT
  dim repo create PROJECT ROOT --root --ref main
  git push "$(dim repo url-for-host PROJECT ROOT)" main
  dim create PROJECT WORKSPACE
  dim exec WORKSPACE -- bash

Run 'dim help --all' to list administrative commands.`);

const project = program.command("project").description("Manage project metadata and Git namespaces");

project.command("create")
  .description("Create a project and its managed Git namespace")
  .argument("<project>")
  .action(async (name: string) => print(await createProject(runner, lifecycleOptions(), name)));

project.command("list")
  .alias("ls")
  .description("List projects")
  .action(async () => printList(await listProjects(lifecycleOptions()), ["name", "phase", "gitNamespace", "rootRepositoryAlias", "rootRef"]));

project.command("show")
  .description("Show a project")
  .argument("<project>")
  .action(async (name: string) => print(await showProject(lifecycleOptions(), name)));

project.command("remove")
  .description("Remove project metadata while preserving Git repositories")
  .argument("<project>")
  .action(async (name: string) => {
    await removeProject(lifecycleOptions(), name);
  });

project.command("purge")
  .description("Delete an unused project and its DIM-managed Git organization")
  .argument("<project>")
  .requiredOption("--yes", "confirm permanent repository deletion")
  .action(async (name: string) => purgeProject(runner, lifecycleOptions(), name));

const repo = program.command("repo").description("Manage project-scoped repositories");

repo.command("create")
  .description("Create an empty managed repository")
  .argument("<project>")
  .argument("<alias>")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref", "main")
  .option("--protect <patterns>", "comma-separated protected branch patterns", "main")
  .action(async (projectName: string, alias: string, flags: RepoFlags) => {
    print(await createProjectRepository(runner, lifecycleOptions(), {
      project: projectName,
      alias,
      protectedPatterns: commaSeparated(flags.protect),
      root: flags.root ?? false,
      ...(flags.root ? { rootRef: flags.ref } : {})
    }));
  });

repo.command("import")
  .description("Create a managed repository and mirror an existing Git URL")
  .argument("<project>")
  .argument("<alias>")
  .argument("<source>")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref", "main")
  .option("--protect <patterns>", "comma-separated protected branch patterns", "main")
  .action(async (projectName: string, alias: string, source: string, flags: RepoFlags) => {
    print(await importProjectRepository(runner, lifecycleOptions(), {
      project: projectName,
      alias,
      source,
      protectedPatterns: commaSeparated(flags.protect),
      root: flags.root ?? false,
      ...(flags.root ? { rootRef: flags.ref } : {})
    }));
  });

repo.command("list")
  .alias("ls")
  .description("List repositories in a project")
  .argument("<project>")
  .action(async (name: string) =>
    printList(await listProjectRepositories(lifecycleOptions(), name), ["alias", "phase", "hostUrl", "workspaceUrl"])
  );

repo.command("show")
  .description("Show a project repository")
  .argument("<project>")
  .argument("<alias>")
  .action(async (name: string, alias: string) => print(await showProjectRepository(lifecycleOptions(), name, alias)));

repo.command("protect")
  .description("Apply configured branch protection after the initial push")
  .argument("<project>")
  .argument("<alias>")
  .action(async (name: string, alias: string) =>
    print(await applyProjectRepositoryProtection(runner, lifecycleOptions(), name, alias))
  );

repo.command("url-for-host")
  .description("Print the repository URL reachable from the host")
  .argument("<project>")
  .argument("<alias>")
  .action(async (name: string, alias: string) => console.log(await projectRepositoryHostUrl(lifecycleOptions(), name, alias)));

repo.command("url-for-workspace")
  .description("Print the repository URL reachable from workspaces")
  .argument("<project>")
  .argument("<alias>")
  .action(async (name: string, alias: string) => console.log(await projectRepositoryWorkspaceUrl(lifecycleOptions(), name, alias)));

program.command("create")
  .description("Create a persistent workspace for a project")
  .argument("<project>")
  .argument("<workspace>")
  .option("--backend <backend>", "sysbox, gvisor, rootless-podman, or runc")
  .option("--profile <profile>", "Compose capability profile", collect, [])
  .option("--git-user-name <name>")
  .option("--git-user-email <email>")
  .action(async (projectName: string, name: string, flags: WorkspaceCreateFlags) => {
    const options = lifecycleOptions();
    print(await createWorkspace(runner, options, {
      project: projectName,
      name,
      profiles: flags.profile,
      runtimeBackend: workspaceBackend(flags.backend ?? options.defaultWorkspaceBackend),
      ...(flags.gitUserName ? { gitUserName: flags.gitUserName } : {}),
      ...(flags.gitUserEmail ? { gitUserEmail: flags.gitUserEmail } : {})
    }));
  });

program.command("ls")
  .alias("list")
  .description("List workspaces")
  .action(async () =>
    printList(await listWorkspaces(lifecycleOptions()), ["name", "projectName", "phase", "runtimeBackend", "rootRef"])
  );

program.command("show")
  .description("Show a workspace")
  .argument("<workspace>")
  .action(async (name: string) => print(await showWorkspace(lifecycleOptions(), name)));

program.command("exec")
  .description("Execute a raw command in a running workspace")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    process.exitCode = await execWorkspace(runner, lifecycleOptions(), {
      name,
      command,
      interactive: interactive()
    });
  });

program.command("run")
  .description("Run a root project task through .dim/entrypoint.sh")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    process.exitCode = await runWorkspace(runner, lifecycleOptions(), {
      name,
      command: task,
      interactive: interactive()
    });
  });

program.command("setup")
  .description("Retry root project environment setup")
  .argument("<workspace>")
  .action(async (name: string) => print(await setupWorkspace(runner, lifecycleOptions(), name)));

program.command("update")
  .description("Fast-forward the root ref and run setup")
  .argument("<workspace>")
  .option("--profile <profile>", "replace Compose capability profiles", collect, [])
  .option("--clear-profiles", "remove all capability profiles")
  .action(async (name: string, flags: { profile: string[]; clearProfiles?: boolean }) => {
    if (flags.clearProfiles && flags.profile.length > 0) {
      throw new UserError("--clear-profiles cannot be combined with --profile");
    }
    print(await updateWorkspace(
      runner,
      lifecycleOptions(),
      name,
      flags.clearProfiles ? [] : flags.profile.length > 0 ? flags.profile : undefined
    ));
  });

program.command("start")
  .description("Start a stopped workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .action(async (name: string) => print(await startWorkspace(runner, lifecycleOptions(), name)));

program.command("restart")
  .description("Restart a workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .action(async (name: string) => print(await restartWorkspace(runner, lifecycleOptions(), name)));

program.command("stop")
  .description("Stop a workspace while preserving its checkout and inner-engine data")
  .argument("<workspace>")
  .action(async (name: string) => stopWorkspace(runner, lifecycleOptions(), name));

program.command("discard")
  .description("Permanently delete a workspace and unpushed changes")
  .argument("<workspace>")
  .requiredOption("--yes", "confirm permanent deletion")
  .action(async (name: string) => discardWorkspace(runner, lifecycleOptions(), name));

program.command("doctor")
  .description("Check host and workspace runtime readiness")
  .option("--backend <backend>", "sysbox, gvisor, rootless-podman, or runc")
  .action(async (flags: { backend?: string }) => {
    const options = lifecycleOptions();
    const checks = await runDoctor(runner, workspaceBackend(flags.backend ?? options.defaultWorkspaceBackend), options);
    for (const check of checks) console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

const plugin = program.command("plugin").description("Inspect installed DIM plugins");
plugin.command("list").action(async () => {
  const home = await resolvePluginHome();
  const loaded = await loadInstalledPlugins(home);
  print({
    pluginHome: home,
    plugins: loaded.manifest.plugins
  });
});

const admin = program.command("admin", { hidden: true }).description("Low-level service administration");
const service = admin.command("service");
service.command("ensure").description("Reconcile the managed Gitea service").action(async () => {
  await ensureGitea(runner, lifecycleOptions());
  console.log("Managed Gitea is ready");
});
service.command("credentials")
  .description("Print managed Gitea credentials")
  .requiredOption("--show-secrets")
  .action(async () => print(await ensureGitea(runner, lifecycleOptions())));

const x = program.command("x").description("Run a command with DIM-provided integration settings");
x.command("git")
  .description("Run Git with managed Gitea credentials")
  .argument("<args...>")
  .allowUnknownOption(true)
  .action(async (args: string[]) => {
    const credentials = await ensureGitea(runner, lifecycleOptions());
    const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
    process.exitCode = await runner.runStreaming("git", ["-c", `credential.helper=${helper}`, ...args], {
      env: {
        ...process.env,
        DIM_GIT_USERNAME: credentials.writerUsername,
        DIM_GIT_TOKEN: credentials.writerPassword,
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  });

program.command("help")
  .description("Show help")
  .option("--all", "include administrative commands")
  .action((flags: { all?: boolean }) => {
    if (flags.all) admin.showHelpAfterError();
    program.outputHelp();
    if (flags.all) {
      console.log("\nAdministrative commands:");
      admin.outputHelp();
    }
  });

program.exitOverride();

interface RepoFlags {
  root?: boolean;
  ref: string;
  protect: string;
}

interface WorkspaceCreateFlags {
  backend?: string;
  profile: string[];
  gitUserName?: string;
  gitUserEmail?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function commaSeparated(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new UserError("--protect must contain at least one pattern");
  return values;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function wantsJson(): boolean {
  return Boolean(program.opts<{ json?: boolean }>().json);
}

function print(value: unknown): void {
  if (wantsJson() || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

function printList<T extends object>(records: T[], fields: string[]): void {
  if (wantsJson()) {
    print(records);
    return;
  }
  if (records.length === 0) return;
  console.table(records.map((record) => {
    const values = record as Record<string, unknown>;
    return Object.fromEntries(fields.map((field) => [field, values[field] ?? ""]));
  }));
}

main();

async function main(): Promise<void> {
  try {
    const argv = process.argv[2] === "--"
      ? [process.argv[0] ?? "node", process.argv[1] ?? "dim", ...process.argv.slice(3)]
      : process.argv;
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = error.exitCode || 2;
      return;
    }
    if (error instanceof UserError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  }
}
