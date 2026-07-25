#!/usr/bin/env node
import { once } from "node:events";
import { AddHelpTextContext, Command, CommanderError } from "commander";
import {
  applyProjectRepositoryProtection,
  createProject,
  createProjectRepository,
  createWorkspace,
  configuredDimController,
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
  initializeControllerRoutes,
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
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("afterAll", installerFacadeHelpText);

const project = program.command("project").description("Manage project metadata and Git namespaces");

project.command("create")
  .description("Create a project and its managed Git namespace")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await createProject(runner, lifecycleOptions(), name), flags));

project.command("list")
  .alias("ls")
  .description("List projects")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(await listProjects(lifecycleOptions()), ["name", "phase", "gitNamespace", "rootRepositoryAlias", "rootRef"], flags)
  );

project.command("show")
  .description("Show a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await showProject(lifecycleOptions(), name), flags));

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
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, alias: string, flags: RepoFlags) => {
    print(await createProjectRepository(runner, lifecycleOptions(), {
      project: projectName,
      alias,
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      root: flags.root ?? false,
      ...(flags.root ? { rootRef: flags.ref } : {})
    }), flags);
  });

repo.command("import")
  .description("Create a managed repository and mirror an existing Git URL")
  .argument("<project>")
  .argument("<alias>")
  .argument("<source>")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, alias: string, source: string, flags: RepoFlags) => {
    print(await importProjectRepository(runner, lifecycleOptions(), {
      project: projectName,
      alias,
      source,
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      root: flags.root ?? false,
      ...(flags.root ? { rootRef: flags.ref } : {})
    }), flags);
  });

repo.command("list")
  .alias("ls")
  .description("List repositories in a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) =>
    printList(await listProjectRepositories(lifecycleOptions(), name), ["alias", "phase", "hostUrl", "workspaceUrl"], flags)
  );

repo.command("show")
  .description("Show a project repository")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await showProjectRepository(lifecycleOptions(), name, alias), flags)
  );

repo.command("protect")
  .description("Apply configured branch protection after the initial push")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await applyProjectRepositoryProtection(runner, lifecycleOptions(), name, alias), flags)
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
  .option("--cpus <count>", "workspace CPU limit")
  .option("--memory <size>", "workspace memory limit")
  .option("--pids-limit <count>", "workspace PID limit")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, name: string, flags: WorkspaceCreateFlags) => {
    const options = lifecycleOptions();
    print(await createWorkspace(runner, options, {
      project: projectName,
      name,
      profiles: flags.profile,
      runtimeBackend: workspaceBackend(flags.backend ?? options.defaultWorkspaceBackend),
      cpuCount: flags.cpus ?? options.cpuCount,
      memory: flags.memory ?? options.memory,
      pidsLimit: flags.pidsLimit ?? options.pidsLimit,
      ...(flags.gitUserName ? { gitUserName: flags.gitUserName } : {}),
      ...(flags.gitUserEmail ? { gitUserEmail: flags.gitUserEmail } : {})
    }), flags);
  });

program.command("ls")
  .alias("list")
  .description("List workspaces")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(
      await listWorkspaces(lifecycleOptions()),
      ["name", "projectName", "phase", "runtimeBackend", "rootRef"],
      flags
    )
  );

program.command("show")
  .description("Show a workspace")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await showWorkspace(lifecycleOptions(), name), flags));

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
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await setupWorkspace(runner, lifecycleOptions(), name), flags));

program.command("update")
  .description("Fast-forward the root ref and run setup")
  .argument("<workspace>")
  .option("--profile <profile>", "replace Compose capability profiles", collect, [])
  .option("--clear-profiles", "remove all capability profiles")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: { profile: string[]; clearProfiles?: boolean; json?: boolean }) => {
    if (flags.clearProfiles && flags.profile.length > 0) {
      throw new UserError("--clear-profiles cannot be combined with --profile");
    }
    print(await updateWorkspace(
      runner,
      lifecycleOptions(),
      name,
      flags.clearProfiles ? [] : flags.profile.length > 0 ? flags.profile : undefined
    ), flags);
  });

program.command("start")
  .description("Start a stopped workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await startWorkspace(runner, lifecycleOptions(), name), flags));

program.command("restart")
  .description("Restart a workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await restartWorkspace(runner, lifecycleOptions(), name), flags));

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
plugin.command("list").option("--json", "print machine-readable JSON").action(async (flags: JsonFlags) => {
  const home = await resolvePluginHome();
  const loaded = await loadInstalledPlugins(home);
  try {
    print({
      pluginHome: home,
      plugins: loaded.manifest.plugins,
      controllerRoutes: loaded.registered.controllerRoutes.map((route) => `${route.method} /api${route.path}`)
    }, flags);
  } finally {
    await loaded.registered.dispose();
  }
});

const controller = program.command("controller").description("Run trusted DIM controller services");
controller.command("serve")
  .description("Serve the workspace external URL API")
  .option("--host <host>", "listen address", process.env.DIM_CONTROLLER_HOST ?? "0.0.0.0")
  .option("--port <port>", "listen port", process.env.DIM_CONTROLLER_PORT ?? "7070")
  .action(async (flags: { host: string; port: string }) => {
    const port = Number(flags.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new UserError("--port must be between 1 and 65535");
    }
    const loaded = await loadInstalledPlugins(await resolvePluginHome());
    if (loaded.registered.controllerRoutes.length === 0) {
      await loaded.registered.dispose();
      throw new UserError("DIM controller requires at least one plugin route");
    }
    await initializeControllerRoutes(lifecycleOptions(), loaded.registered);
    const server = configuredDimController(lifecycleOptions(), loaded.registered);
    server.listen(port, flags.host);
    await once(server, "listening");
    console.log(`DIM controller listening on http://${flags.host}:${port}`);
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await loaded.registered.dispose();
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
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => print(await ensureGitea(runner, lifecycleOptions()), flags));

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

const gitIntegration = program.command("git").description("Configure Git access to DIM-managed repositories");
gitIntegration.command("setup")
  .description("Install DIM's URL-scoped Git credential helper in global Git config")
  .action(async () => {
    await ensureGitea(runner, lifecycleOptions());
    const baseUrl = `http://127.0.0.1:${lifecycleOptions().giteaPort}`;
    const helperKey = `credential.${baseUrl}.helper`;
    const pathKey = `credential.${baseUrl}.useHttpPath`;
    const helper = await runner.run("git", ["config", "--global", "--replace-all", helperKey, "!dim git credential-helper"]);
    if (helper.exitCode !== 0) throw new UserError(`failed to configure Git credential helper: ${helper.stderr.trim()}`);
    const usePath = await runner.run("git", ["config", "--global", "--replace-all", pathKey, "true"]);
    if (usePath.exitCode !== 0) throw new UserError(`failed to configure Git credential path matching: ${usePath.stderr.trim()}`);
    console.log(`Configured DIM credentials for ${baseUrl}`);
  });

gitIntegration.command("credential-helper", { hidden: true })
  .description("Serve credentials using the Git credential-helper protocol")
  .argument("[operation]", "get, store, or erase", "get")
  .action(async (operation: string) => {
    const input = await readStdin();
    if (operation !== "get") return;
    const fields = Object.fromEntries(input
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
    const options = lifecycleOptions();
    if (fields.protocol !== "http" || fields.host !== `127.0.0.1:${options.giteaPort}`) return;
    const credentials = await ensureGitea(runner, options);
    console.log(`username=${credentials.writerUsername}`);
    console.log(`password=${credentials.writerPassword}`);
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
  ref?: string;
  protect?: string;
  json?: boolean;
}

interface JsonFlags {
  json?: boolean;
}

interface WorkspaceCreateFlags extends JsonFlags {
  backend?: string;
  profile: string[];
  gitUserName?: string;
  gitUserEmail?: string;
  cpus?: string;
  memory?: string;
  pidsLimit?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function commaSeparated(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new UserError("--protect must contain at least one pattern");
  return values;
}

function installerFacadeHelpText(context: AddHelpTextContext): string {
  const rootText = `
Typical flow:
  dim project create PROJECT
  dim repo create PROJECT ROOT --root
  git push "$(dim repo url-for-host PROJECT ROOT)" main
  dim repo protect PROJECT ROOT
  dim create PROJECT WORKSPACE
  dim exec WORKSPACE -- bash

Run 'dim help --all' to list administrative commands.`;

  if (process.env.DIM_INVOKED_VIA_INSTALLER !== "1") {
    return context.command === program ? rootText : "";
  }

  const installerVersion = process.env.DIM_INSTALLER_VERSION;
  const installerSuffix = installerVersion ? ` ${installerVersion}` : "";

  if (context.command !== program) {
    return `\nRunning via the DIM installer facade${installerSuffix}.`;
  }

  return `${rootText}

Running via the DIM installer facade${installerSuffix}. The following installer commands are also
available:
  dim installer        interactive installer UI
  dim install-cli      install or upgrade the DIM CLI
  dim install-plugin   install a DIM plugin`;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

function print(value: unknown, flags: JsonFlags = {}): void {
  if (flags.json || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

function printList<T extends object>(records: T[], fields: string[], flags: JsonFlags = {}): void {
  if (flags.json) {
    print(records, flags);
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
