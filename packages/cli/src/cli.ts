#!/usr/bin/env node
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { Command, CommanderError, type AddHelpTextContext } from "commander";
import {
  configuredDimAdminController,
  configuredDimController,
  configuredWorkspaceBackend,
  execWorkspace,
  inspectWorkspaceBackends,
  lifecycleOptions,
  lifecycleOptionsForBackend,
  type LifecycleOptions,
  loadInstalledPlugins,
  ProcessRunner,
  parseRepositorySetYaml,
  assertRepositorySetCanCreateProject,
  mapExternalRefToRepository,
  mapRepositoryRefToExternal,
  normalizeRootRef,
  resolveRepositoryConnection,
  type RepositoryRefNamespace,
  type RepositorySet,
  type RepositorySetEntry,
  initializeControllerRoutes,
  resolvePluginHome,
  runCommonDoctorChecks,
  runDoctor,
  runWorkspace,
  runtimeBackendChecks,
  setConfiguredWorkspaceBackend,
  configuredCiRunnerDefaults,
  setConfiguredCiRunnerDefaults,
  BUILTIN_CI_RUNNER_DEFAULTS,
  UserError,
  type WorkspaceRuntimeBackendKind,
} from "@slop-lab/dim-core";

const runner = new ProcessRunner();
const program = new Command();

program
  .name("dim")
  .description("Isolated, persistent development workspaces")
  .version("0.8.0")
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("afterAll", installerFacadeHelpText);

const project = program.command("project").description("Manage project metadata and Git namespaces");

project.command("create")
  .description("Create a project and its managed Git namespace")
  .argument("<project>")
  .option("--repos <file>", "create and populate from a repos.yml file")
  .option("--root <alias>", "import or create the root repository with this alias")
  .option("--url <url>", "discover .dim/repos.yml and import its root from this Git URL or path")
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--mirror", "import every root ref instead of only branches and tags")
  .option("--apply-repos", "apply the root .dim/repos.yml without prompting")
  .option("--no-apply-repos", "do not apply the root .dim/repos.yml")
  .option("--yes", "apply the repository plan without prompting")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags & {
    repos?: string;
    root?: string;
    url?: string;
    ref?: string;
    protect?: string;
    applyRepos?: boolean;
    mirror?: boolean;
    yes?: boolean;
  }) => {
    const rootOptionsPresent = flags.root !== undefined || flags.url !== undefined || flags.ref !== undefined
      || flags.protect !== undefined
      || flags.mirror !== undefined
      || flags.applyRepos !== undefined;
    if (flags.repos !== undefined && rootOptionsPresent) {
      throw new UserError("--repos cannot be combined with root repository options");
    }
    if (flags.root === undefined && flags.url === undefined && rootOptionsPresent) {
      throw new UserError("--root or --url is required with --ref or repository apply options");
    }
    if (flags.root === undefined && (flags.protect !== undefined || flags.mirror !== undefined)) {
      throw new UserError("--protect and --mirror require --root; manifest bootstrap reads root policy from .dim/repos.yml");
    }
    if (process.argv.includes("--apply-repos") && process.argv.includes("--no-apply-repos")) {
      throw new UserError("--apply-repos and --no-apply-repos cannot be used together");
    }
    if (flags.repos === undefined && flags.root === undefined && flags.url === undefined) {
      print(await adminCall("project.create", { name }), flags);
      return;
    }
    if (flags.repos !== undefined) {
      const set = await readRepositorySetFile(flags.repos);
      assertRepositorySetCanCreateProject(set, flags.repos);
      const plan = await repositorySetPlan(name, set, true);
      await approveRepositoryPlan(plan, flags.yes ?? false, !flags.json);
      await adminCall("project.create", { name });
      const repositories = await applyRepositorySet(name, set, plan);
      print({ project: name, repositories }, flags);
      return;
    }

    let rootAlias = flags.root;
    let rootSet: RepositorySet | undefined;
    if (rootAlias === undefined) {
      rootSet = await readRemoteRepositorySet(flags.url!, flags.ref);
      assertRepositorySetCanCreateProject(rootSet, `${flags.url!}:.dim/repos.yml`);
      [rootAlias] = Object.entries(rootSet.repositories).find(([, entry]) => entry.root)!;
      const connection = resolveRepositoryConnection(rootSet, rootAlias);
      if (connection?.url !== flags.url) {
        throw new UserError(
          `remote manifest root '${rootAlias}' URL '${connection?.url ?? "(empty)"}' does not match bootstrap URL '${flags.url}'`
        );
      }
    }
    const rootEntry = rootSet?.repositories[rootAlias];
    if (flags.ref !== undefined && rootEntry?.rootRef !== undefined
      && normalizeRootRef(flags.ref) !== normalizeRootRef(rootEntry.rootRef)) {
      throw new UserError(
        `--ref '${flags.ref}' conflicts with manifest root ref '${rootEntry.rootRef}' for '${rootAlias}'`
      );
    }
    const selectedRootRef = rootEntry?.rootRef ?? flags.ref;
    await createOrResumeRootProject(name, rootAlias, flags.url);
    const repository = await addRepository(name, rootAlias, {
      ...(flags.url === undefined ? {} : { url: flags.url }),
      fallback: rootEntry?.fallback ?? false,
      root: true,
      ...(selectedRootRef === undefined ? {} : { rootRef: selectedRootRef }),
      protectedPatterns: rootEntry?.protectedPatterns
        ?? (flags.protect === undefined ? [] : commaSeparated(flags.protect)),
      mirror: flags.mirror ?? false
    }, rootSet);
    print({ project: name, repository }, flags);
    await offerRootRepositorySet(name, flags.applyRepos);
  });

project.command("list")
  .alias("ls")
  .description("List projects")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(await adminCall<Record<string, unknown>[]>("project.list"), ["name", "phase", "gitNamespace", "rootRepositoryAlias", "rootRef"], flags)
  );

project.command("show")
  .description("Show a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await adminCall("project.show", { name }), flags));

project.command("remove")
  .description("Remove project metadata while preserving Git repositories")
  .argument("<project>")
  .action(async (name: string) => {
    await adminCall("project.remove", { name });
  });

project.command("purge")
  .description("Delete an unused project and its DIM-managed Git organization")
  .argument("<project>")
  .option("--yes", "confirm permanent repository deletion")
  .action(async (name: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete project '${name}' and its managed repositories?`);
    await adminCall("project.purge", { name });
  });

const repo = program.command("repo").description("Manage project-scoped repositories");

repo.command("add")
  .description("Add an empty repository or import an external Git URL")
  .argument("<project>")
  .argument("<alias>")
  .argument("[url]")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--mirror", "import every ref instead of only branches and tags")
  .option("--apply-repos", "apply .dim/repos.yml after adding the root")
  .option("--no-apply-repos", "do not apply .dim/repos.yml after adding the root")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, alias: string, url: string | undefined, flags: RepoFlags & { applyRepos?: boolean; mirror?: boolean }) => {
    if (process.argv.includes("--apply-repos") && process.argv.includes("--no-apply-repos")) {
      throw new UserError("--apply-repos and --no-apply-repos cannot be used together");
    }
    if (!flags.root && flags.applyRepos !== undefined) {
      throw new UserError("repository apply options require --root");
    }
    const repository = await addRepository(projectName, alias, {
      ...(url === undefined ? {} : { url }),
      fallback: false,
      root: flags.root ?? false,
      ...(flags.ref === undefined ? {} : { rootRef: flags.ref }),
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      mirror: flags.mirror ?? false
    });
    print(repository, flags);
    if (flags.root) await offerRootRepositorySet(projectName, flags.applyRepos);
  });

repo.command("plan")
  .description("Preview repositories from repos.yml without changing state")
  .argument("<project>")
  .option("--file <file>", "read an explicit repos.yml instead of the managed root")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, flags: JsonFlags & { file?: string }) => {
    const set = await resolveRepositorySet(projectName, flags.file);
    print(await repositorySetPlan(projectName, set, false), flags);
  });

repo.command("apply")
  .description("Reconcile repositories from repos.yml")
  .argument("<project>")
  .option("--file <file>", "read an explicit repos.yml instead of the managed root")
  .option("--yes", "apply without prompting")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, flags: JsonFlags & { file?: string; yes?: boolean }) => {
    const set = await resolveRepositorySet(projectName, flags.file);
    const plan = await repositorySetPlan(projectName, set, false);
    await approveRepositoryPlan(plan, flags.yes ?? false, !flags.json);
    print(await applyRepositorySet(projectName, set, plan), flags);
  });

repo.command("list")
  .alias("ls")
  .description("List repositories in a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) =>
    printList(await adminCall<Record<string, unknown>[]>("repo.list", { project: name }), ["alias", "phase", "hostUrl", "workspaceUrl"], flags)
  );

repo.command("show")
  .description("Show a project repository")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await adminCall("repo.show", { project: name, alias }), flags)
  );

repo.command("delete")
  .description("Delete an unused non-root repository from DIM and managed Gitea")
  .argument("<project>")
  .argument("<alias>")
  .option("--yes", "confirm permanent repository deletion")
  .action(async (project: string, alias: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete repository '${project}/${alias}'?`);
    await adminCall("repo.delete", { project, alias });
  });

repo.command("protect")
  .description("Apply configured branch protection after the initial push")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await adminCall("repo.protect", { project: name, alias }), flags)
  );

repo.command("fetch")
  .description("Fetch external branches into upstream/* and import tags")
  .argument("<project>")
  .argument("<alias>")
  .option("--prune", "delete upstream/* branches removed from the external repository")
  .action(async (projectName: string, alias: string, flags: { prune?: boolean }) => {
    await fetchRepository(projectName, alias, flags.prune ?? false);
  });

repo.command("push")
  .description("Push explicit branch or tag refspecs to the external repository")
  .argument("<project>")
  .argument("<alias>")
  .argument("<refspec...>", "source:destination branch or tag refspecs")
  .action(async (projectName: string, alias: string, refspecs: string[]) => {
    await pushRepository(projectName, alias, refspecs);
  });

repo.command("url")
  .description("Print a repository URL")
  .argument("<project>")
  .argument("<alias>")
  .option("--workspace", "print the URL reachable from workspaces")
  .action(async (name: string, alias: string, flags: { workspace?: boolean }) =>
    console.log((await adminCall<{ url: string }>("repo.url", {
      project: name,
      alias,
      workspace: flags.workspace ?? false
    })).url));

const ci = program.command("ci").description("Manage isolated CI execution");
const ciRunner = ci.command("runner").description("Manage project CI runners");

ciRunner.command("create")
  .description("Create a named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .argument("<executor>", "sysbox or qemu")
  .option("--cpus <count>")
  .option("--memory <size>")
  .option("--processes <count>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, executor: string, flags: ResourceFlags & JsonFlags) => {
    executor = ciExecutor(executor);
    if (executor === "qemu" && flags.processes !== undefined) throw new UserError("--processes applies only to the sysbox executor");
    print(await adminCall("ci.runner.create", {
      project, name, executor,
      ...(hasResourceFlags(flags) ? { resources: resourceInput(flags) } : {})
    }), flags);
  });

ciRunner.command("list")
  .alias("ls")
  .description("List managed CI runners")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const records = await adminCall<Array<Record<string, unknown> & {
      executor: { kind: string; phase: string };
    }>>("ci.runner.list");
    if (flags.json) {
      print(records, flags);
      return;
    }
    printList(records.map((record) => ({
      projectName: record.projectName,
      name: record.name,
      executor: record.executor.kind,
      phase: record.executor.phase,
      provider: record.provider
    })), ["projectName", "name", "executor", "phase", "provider"]);
  });

ciRunner.command("status")
  .description("Show a named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminCall("ci.runner.show", { project, name }), flags)
  );

ciRunner.command("restart")
  .description("Reconcile and restart a named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminCall("ci.runner.restart", { project, name }), flags));

ciRunner.command("start")
  .description("Start a stopped named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminCall("ci.runner.start", { project, name }), flags));

ciRunner.command("stop")
  .description("Stop a named CI runner without deleting its local data")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminCall("ci.runner.stop", { project, name }), flags)
  );

ciRunner.command("logs")
  .description("Follow project CI runner logs")
  .argument("<project>")
  .argument("<runner>")
  .action(async (project: string, name: string) => {
    const record = await adminCall<{ executor: { kind: "sysbox"; containerName: string } | { kind: "qemu"; supervisorName: string } }>("ci.runner.show", { project, name });
    const containerName = record.executor.kind === "sysbox" ? record.executor.containerName : record.executor.supervisorName;
    process.exitCode = await runner.runStreaming("docker", ["logs", "--follow", containerName]);
  });

ciRunner.command("delete")
  .description("Remove a named CI runner and its local data")
  .argument("<project>")
  .argument("<runner>")
  .option("--yes", "confirm runner and local data deletion")
  .action(async (project: string, name: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete CI runner '${project}/${name}' and its local data?`);
    await adminCall("ci.runner.delete", { project, name });
  });

const ciDefaults = ciRunner.command("defaults").description("Manage inherited CI runner resource defaults");

ciDefaults.command("show")
  .option("--json", "print machine-readable JSON")
  .action((flags: JsonFlags) => {
    const configured = configuredCiRunnerDefaults();
    print({
      resources: configured ?? BUILTIN_CI_RUNNER_DEFAULTS,
      source: configured ? "configured" : "builtin"
    }, flags);
  });

ciDefaults.command("set")
  .requiredOption("--cpus <count>")
  .requiredOption("--memory <size>")
  .requiredOption("--processes <count>")
  .action(async (flags: Required<ResourceFlags>) => {
    console.log(await setConfiguredCiRunnerDefaults(resourceInput(flags) as Required<ReturnType<typeof resourceInput>>));
  });

ciDefaults.command("reset")
  .action(async () => {
    console.log(await setConfiguredCiRunnerDefaults(undefined));
  });

const workspace = program.command("workspace").description("Manage persistent development workspaces");

workspace.command("create")
  .description("Create a persistent workspace for a project")
  .argument("<project>")
  .argument("<workspace>")
  .option("--profile <profile>", "Compose capability profile", collect, [])
  .option("--git-user-name <name>")
  .option("--git-user-email <email>")
  .option("--cpus <count>", "workspace CPU limit")
  .option("--memory <size>", "workspace memory limit")
  .option("--processes <count>", "workspace process limit")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, name: string, flags: WorkspaceCreateFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminCall("workspace.create", {
      project: projectName,
      name,
      profiles: flags.profile,
      runtimeBackend: options.defaultWorkspaceBackend,
      cpuCount: flags.cpus ?? options.cpuCount,
      memory: flags.memory ?? options.memory,
      pidsLimit: flags.processes ?? options.pidsLimit,
      ...(flags.gitUserName ? { gitUserName: flags.gitUserName } : {}),
      ...(flags.gitUserEmail ? { gitUserEmail: flags.gitUserEmail } : {})
    }), flags);
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
  .option("--processes <count>", "workspace process limit")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: ResourceFlags & JsonFlags) => {
    if (!hasResourceFlags(flags)) throw new UserError("provide at least one resource limit");
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminCall("workspace.resources", {
      name,
      ...(flags.cpus === undefined ? {} : { cpuCount: flags.cpus }),
      ...(flags.memory === undefined ? {} : { memory: flags.memory }),
      ...(flags.processes === undefined ? {} : { pidsLimit: flags.processes })
    }), flags);
  });

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

workspace.command("exec")
  .description("Execute a raw command in a running workspace")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    process.exitCode = await execWorkspace(runner, lifecycleOptions(), {
      name, command, interactive: interactive()
    });
  });

workspace.command("run")
  .description("Run a root project task through .dim/entrypoint.sh")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    process.exitCode = await runWorkspace(runner, lifecycleOptions(), {
      name, command: task, interactive: interactive()
    });
  });

workspace.command("align")
  .description("Align the root checkout to its configured ref without running setup")
  .argument("<workspace>")
  .option("--reset", "reset the configured local branch to the fetched ref")
  .option("--yes", "confirm resetting local commits on the configured branch")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags & { reset?: boolean; yes?: boolean }) => {
    if (flags.reset && !flags.yes) throw new UserError("--reset requires --yes");
    print(await adminCall("workspace.align", { name, reset: flags.reset ?? false }), flags);
  });

workspace.command("setup")
  .description("Retry root project environment setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminCall("workspace.setup", { name }), flags);
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
    print(await adminCall("workspace.update", {
      name,
      ...(flags.clearProfiles ? { profiles: [] } : flags.profile.length > 0 ? { profiles: flags.profile } : {})
    }), flags);
  });

workspace.command("start")
  .description("Start a stopped workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminCall("workspace.start", { name }), flags);
  });

workspace.command("restart")
  .description("Restart a workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminCall("workspace.restart", { name }), flags);
  });

workspace.command("stop")
  .description("Stop a workspace while preserving its checkout and inner-engine data")
  .argument("<workspace>")
  .action(async (name: string) => void await adminCall("workspace.stop", { name }));

workspace.command("discard")
  .description("Permanently delete a workspace and unpushed changes")
  .argument("<workspace>")
  .option("--yes", "confirm permanent deletion")
  .action(async (name: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently discard workspace '${name}'?`);
    const options = lifecycleOptions();
    await ensureManagedController(options);
    await externalUrlControllerRequest("/api/urls", { method: "DELETE" }, name).catch((error) => {
      if (!(error instanceof Error) || !error.message.includes("(404)")) throw error;
    });
    await adminCall("workspace.discard", { name });
    if ((await adminCall<unknown[]>("workspace.list")).length === 0) await stopManagedController(options);
  });

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
  .argument("[backend]", "sysbox, gvisor, rootless-podman, or runc")
  .action(async (backendArgument: string | undefined) => {
    const backend = backendArgument === undefined
      ? await selectInstalledWorkspaceBackend()
      : parseWorkspaceBackend(backendArgument);
    const checks = await runtimeBackendChecks(runner, backend, lifecycleOptionsForBackend(backend));
    const requiredChecks = checks.filter((check) => check.name !== "KVM device");
    printDoctorChecks(requiredChecks);
    if (requiredChecks.some((check) => !check.ok)) {
      throw new UserError(`workspace backend '${backend}' is not installed and ready`);
    }
    const target = await setConfiguredWorkspaceBackend(backend);
    console.log(`Configured workspace backend '${backend}' in ${target}`);
  });

const plugin = program.command("plugin").description("Inspect installed DIM plugins");
plugin.command("list").option("--json", "print machine-readable JSON").action(async (flags: JsonFlags) => {
  print(await adminCall<Record<string, unknown>>("plugin.list"), flags);
});

const externalUrl = program.command("external-url").description("Configure ingresses and manage workspace URLs");

const externalUrlDnsProvider = externalUrl.command("dns-provider").description("Manage external URL DNS providers");

externalUrlDnsProvider.command("add")
  .description("Add or replace an external URL DNS provider")
  .argument("<driver>")
  .requiredOption("--name <name>")
  .option("--argument <string>", "opaque driver-specific argument", "")
  .action(async (driver: string, flags: DnsProviderAddFlags) => {
    await externalUrlAdmin("dns-provider-add", {
      driver,
      name: flags.name,
      argument: flags.argument
    });
    console.log(`Configured external URL DNS provider '${flags.name}'`);
  });

const externalUrlIngress = externalUrl.command("ingress").description("Manage host-shared ingresses");

externalUrlIngress.command("add")
  .description("Add or replace a named external URL ingress")
  .argument("<driver>")
  .requiredOption("--name <name>")
  .requiredOption("--description <text>")
  .requiredOption("--scheme <scheme>", "http or https")
  .option("--argument <string>", "opaque driver-specific argument", "")
  .action(async (driver: string, flags: IngressAddFlags) => {
    if (flags.scheme !== "http" && flags.scheme !== "https") throw new UserError("--scheme must be http or https");
    await externalUrlAdmin("ingress-add", {
      driver,
      name: flags.name,
      description: flags.description,
      scheme: flags.scheme,
      argument: flags.argument
    });
    await restartManagedController(lifecycleOptions());
    console.log(`Configured external URL ingress '${flags.name}'`);
  });

externalUrlDnsProvider.command("list")
  .description("List configured external URL DNS providers")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const values = await externalUrlAdmin<Record<string, unknown>[]>("dns-provider-list");
    printList(values, ["name", "driver"], flags);
  });

externalUrlDnsProvider.command("remove")
  .description("Remove an unused external URL DNS provider")
  .argument("<name>")
  .action(async (name: string) => {
    await externalUrlAdmin("dns-provider-remove", { name });
  });

externalUrlIngress.command("list")
  .description("List configured external URL ingresses")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const values = await externalUrlAdmin<Record<string, unknown>[]>("ingress-list");
    printList(values, ["name", "driver", "scheme", "description", "argument"], flags);
  });

externalUrlIngress.command("remove")
  .description("Remove an ingress from host configuration")
  .argument("<name>")
  .option("--cleanup-dns", "remove the ingress wildcard DNS record first")
  .action(async (name: string, flags: { cleanupDns?: boolean }) => {
    await (flags.cleanupDns
      ? externalUrlAdmin("ingress-remove", { name, cleanupDns: true })
      : externalUrlAdmin("ingress-remove", { name, cleanupDns: false }));
    await restartManagedController(lifecycleOptions());
  });

externalUrlIngress.command("verify")
  .description("Verify provider state and HTTPS ingress reachability")
  .argument("<name>")
  .action(async (name: string) => {
    await externalUrlAdmin("ingress-verify", { name });
    console.log(`External URL ingress '${name}' is ready`);
  });

externalUrl.command("discover")
  .description("Discover ingresses available to the current workspace")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: WorkspaceControllerFlags) => {
    const discovery = await externalUrlControllerRequest("/api", {}, flags.workspace);
    const routes = (discovery as { routes?: Array<{ path?: string; discovery?: { ingresses?: unknown[] } }> }).routes ?? [];
    const ingresses = routes.find((route) => route.path === "/api/urls")?.discovery?.ingresses ?? [];
    printList(ingresses as Record<string, unknown>[], ["name", "scheme", "description"], flags);
  });

externalUrl.command("request")
  .description("Create an external URL for a target in the current workspace")
  .requiredOption("--ingress <name>")
  .option("--subdomain <name>", "relative subdomain; defaults to the next workspace-prefixed index")
  .option("--container <name>", "nested container path; repeat up to twice", collect, [])
  .requiredOption("--port <port>")
  .option("--protocol <protocol>", "target protocol", "http")
  .option("--path <path>", "external URL path")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: ExternalUrlCreateFlags) => {
    if (flags.protocol !== "http" && flags.protocol !== "https") {
      throw new UserError("--protocol must be http or https");
    }
    const result = await externalUrlControllerRequest("/api/urls", {
      method: "POST",
      body: JSON.stringify({
        ingress: flags.ingress,
        ...(flags.subdomain === undefined ? {} : { subdomain: flags.subdomain }),
        target: {
          containers: flags.container,
          port: cliPort(flags.port, "--port", false),
          protocol: flags.protocol
        },
        ...(flags.path === undefined ? {} : { path: flags.path })
      })
    }, flags.workspace);
    print(result, flags);
  });

externalUrl.command("list")
  .description("List external URLs for the current workspace")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: WorkspaceControllerFlags) =>
    print(await externalUrlControllerRequest("/api/urls", {}, flags.workspace), flags)
  );

externalUrl.command("revoke")
  .description("Revoke an external URL in the current workspace")
  .argument("<id>")
  .option("--workspace <name>", "use a host-side workspace grant")
  .action(async (id: string, flags: WorkspaceControllerFlags) => {
    await externalUrlControllerRequest(`/api/urls/${encodeURIComponent(id)}`, { method: "DELETE" }, flags.workspace);
  });

const controller = program.command("controller").description("Run trusted DIM controller services");
controller.command("restart")
  .description("Restart the managed controller and reload installed plugins and ingress configuration")
  .action(async () => {
    const options = lifecycleOptions();
    await restartManagedController(options);
    console.log(`Restarted managed DIM controller at ${options.controllerSocketPath}`);
  });

controller.command("serve")
  .description("Serve host-admin and trusted-workspace controller APIs")
  .option("--socket <path>", "listen on a Unix socket")
  .option("--admin-socket <path>", "listen for host administration on a Unix socket")
  .option("--host <host>", "listen address for explicit TCP mode")
  .option("--port <port>", "listen port for explicit TCP mode")
  .action(async (flags: { socket?: string; adminSocket?: string; host?: string; port?: string }) => {
    if (flags.socket && (flags.host || flags.port)) {
      throw new UserError("--socket cannot be combined with --host or --port");
    }
    if (!flags.socket && (!flags.host || !flags.port)) {
      throw new UserError("controller serve requires --socket, or both --host and --port");
    }
    const options = lifecycleOptions();
    const adminSocket = flags.socket
      ? flags.adminSocket ?? options.adminControllerSocketPath
      : undefined;
    const pidPath = flags.socket
      ? path.join(path.dirname(flags.socket), "controller.pid")
      : undefined;
    let ownsPid = false;
    let loaded: Awaited<ReturnType<typeof loadInstalledPlugins>> | undefined;
    let server: ReturnType<typeof configuredDimController> | undefined;
    let adminServer: ReturnType<typeof configuredDimAdminController> | undefined;
    try {
      if (pidPath) {
        await mkdir(path.dirname(pidPath), { recursive: true });
        await claimControllerPid(pidPath);
        ownsPid = true;
      }
      loaded = await loadInstalledPlugins(await resolvePluginHome());
      await initializeControllerRoutes(options, loaded.registered);
      server = configuredDimController(options, loaded.registered);
      adminServer = configuredDimAdminController(options, loaded.registered);
      if (flags.socket && adminSocket) {
        await prepareControllerSocket(flags.socket);
        const workspaceListening = once(server, "listening");
        server.listen(flags.socket);
        await workspaceListening;
        await prepareControllerSocket(adminSocket);
        const adminListening = once(adminServer, "listening");
        adminServer.listen(adminSocket);
        await adminListening;
        await chmod(adminSocket, 0o600);
        await chmod(flags.socket, 0o666);
        console.log(`DIM workspace controller listening on ${flags.socket}`);
        console.log(`DIM admin controller listening on ${adminSocket}`);
      } else {
        const port = Number(flags.port);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
          throw new UserError("--port must be between 1 and 65535");
        }
        const listening = once(server, "listening");
        server.listen(port, flags.host);
        await listening;
        console.log(`DIM controller listening on http://${flags.host}:${flags.port}`);
      }
      await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    } finally {
      try {
        await loaded?.registered.dispose();
      } finally {
        try {
          await Promise.all([
            closeControllerServer(server),
            closeControllerServer(adminServer)
          ]);
        } finally {
          if (ownsPid && pidPath && await pidFileOwnedByCurrentProcess(pidPath)) {
            if (flags.socket) await rm(flags.socket, { force: true });
            if (adminSocket) await rm(adminSocket, { force: true });
            await rm(pidPath, { force: true });
          }
        }
      }
    }
  });

const hostInput = program.command("host-input").description("Read an allowed host setting from a workspace");
hostInput.command("get")
  .argument("<provider>")
  .argument("<key>")
  .option("--parameters <parameters>")
  .action(async (provider: string, key: string, flags: { parameters?: string }) => {
    const result = await controllerRequest(
      `/api/host-inputs/${encodeURIComponent(provider)}`,
      {
        method: "POST",
        body: JSON.stringify({ key, ...(flags.parameters === undefined ? {} : { parameters: flags.parameters }) })
      }
    ) as { value?: unknown };
    if (typeof result.value !== "string") throw new UserError("host input provider returned an invalid value");
    process.stdout.write(`${result.value}\n`);
  });

const admin = program.command("admin", { hidden: true }).description("Low-level service administration");
const service = admin.command("service");
service.command("ensure").description("Reconcile the managed Gitea service").action(async () => {
  await adminCall("service.ensure");
  console.log("Managed Gitea is ready");
});
service.command("credentials")
  .description("Print managed Gitea credentials")
  .requiredOption("--show-secrets")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => print(await adminCall("service.ensure"), flags));

const x = program.command("x").description("Run a command with DIM-provided integration settings");
x.command("git")
  .description("Run Git with managed Gitea credentials")
  .argument("<args...>")
  .allowUnknownOption(true)
  .action(async (args: string[]) => {
    const credentials = await adminCall<{ writerUsername: string; writerPassword: string }>("git.credentials");
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
    const { baseUrl } = await adminCall<{ baseUrl: string }>("git.setup");
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
    const credentials = await adminCall<{ writerUsername: string; writerPassword: string }>("git.credentials");
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

interface ResourceFlags {
  cpus?: string;
  memory?: string;
  processes?: string;
}

interface WorkspaceCreateFlags extends JsonFlags {
  profile: string[];
  gitUserName?: string;
  gitUserEmail?: string;
  cpus?: string;
  memory?: string;
  processes?: string;
}

interface DnsProviderAddFlags {
  name: string;
  argument: string;
}

interface IngressAddFlags {
  name: string;
  description: string;
  scheme: "http" | "https";
  argument: string;
}

interface ExternalUrlCreateFlags extends JsonFlags {
  ingress: string;
  subdomain?: string;
  container: string[];
  port: string;
  protocol: "http" | "https";
  path?: string;
  workspace?: string;
}

interface WorkspaceControllerFlags extends JsonFlags {
  workspace?: string;
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
  dim repo add PROJECT ROOT SOURCE_URL --root --ref main
  dim workspace create PROJECT WORKSPACE
  dim workspace exec WORKSPACE -- bash

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

async function confirmAction(yes: boolean, question: string): Promise<void> {
  if (yes) return;
  if (!interactive()) throw new UserError("confirmation requires --yes in a non-interactive shell");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new UserError("operation was not confirmed");
  } finally {
    prompt.close();
  }
}

function parseWorkspaceBackend(value: string): WorkspaceRuntimeBackendKind {
  if (value === "sysbox" || value === "gvisor" || value === "rootless-podman" || value === "runc") {
    return value;
  }
  throw new UserError("backend must be sysbox, gvisor, rootless-podman, or runc");
}

async function selectInstalledWorkspaceBackend(): Promise<WorkspaceRuntimeBackendKind> {
  const installed = (await inspectWorkspaceBackends(runner))
    .filter((inspection) => inspection.ok)
    .map((inspection) => inspection.backend);
  if (installed.length === 0) {
    throw new UserError("no installed workspace backend detected; install a host backend first");
  }
  if (installed.length === 1) return installed[0]!;
  if (!interactive()) {
    throw new UserError(
      `multiple installed workspace backends detected (${installed.join(", ")}); specify one explicitly`
    );
  }
  console.log("Select an installed workspace backend:");
  installed.forEach((backend, index) => console.log(`  ${index + 1}) ${backend}`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("Selection: ")).trim();
    const index = Number(answer) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= installed.length) {
      throw new UserError("invalid backend selection");
    }
    return installed[index]!;
  } finally {
    prompt.close();
  }
}

function printDoctorChecks(checks: Array<{ name: string; ok: boolean; detail: string }>): void {
  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
  }
}

interface RepositorySetPlan {
  project: string;
  createProject: boolean;
  actions: Array<{
    action: "create" | "retry" | "unchanged" | "conflict";
    alias: string;
    entry: RepositorySetEntry;
    detail?: string;
  }>;
}

interface PreparedRepositoryTransfer {
  transferId?: string;
  repository: Record<string, unknown>;
  sourceUrl?: string;
  targetUrl: string;
  writerUsername?: string;
  writerPassword?: string;
}

interface PreparedRepositorySync {
  externalUrl: string;
  refNamespace?: RepositoryRefNamespace;
  managedUrl: string;
  writerUsername: string;
  writerPassword: string;
}

async function fetchRepository(projectName: string, alias: string, prune: boolean): Promise<void> {
  const prepared = await adminCall<PreparedRepositorySync>("repo.sync-prepare", {
    project: projectName,
    alias
  });
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-repo-fetch-"));
  const gitDirectory = path.join(temporary, "sync.git");
  try {
    await runGit(["init", "--bare", gitDirectory], process.env, "initialize temporary repository");
    await runGit([
      "--git-dir", gitDirectory,
      "fetch", "--no-tags", prepared.externalUrl,
      "+refs/heads/*:refs/dim-external/heads/*",
      "+refs/tags/*:refs/dim-external/tags/*"
    ], process.env, `fetch external repository '${projectName}/${alias}'`);
    await materializeExternalRefs(gitDirectory, prepared.refNamespace, true);

    const managedEnvironment = managedGitEnvironment(prepared);
    const upstreamRefs = await localRefs(gitDirectory, "refs/heads/upstream");
    const tagRefs = await localRefs(gitDirectory, "refs/tags");
    const managedUpstreamRefs = prune
      ? await remoteRefs(prepared.managedUrl, "refs/heads/upstream/*", managedEnvironment)
      : [];
    const branchRefspecs = upstreamRefs.map((ref) => `+${ref}:${ref}`);
    if (prune) {
      const fetched = new Set(upstreamRefs);
      branchRefspecs.push(...managedUpstreamRefs.filter((ref) => !fetched.has(ref)).map((ref) => `:${ref}`));
    }
    const tagRefspecs = tagRefs.map((ref) => `${ref}:${ref}`);
    if (tagRefspecs.length > 0) {
      await runGit([
        "--git-dir", gitDirectory,
        "push", "--dry-run", "--atomic", prepared.managedUrl,
        ...tagRefspecs
      ], managedEnvironment, `check tags for '${projectName}/${alias}'`);
    }
    if (branchRefspecs.length > 0) {
      await runGit([
        "--git-dir", gitDirectory,
        "push", "--atomic", prepared.managedUrl,
        ...branchRefspecs
      ], managedEnvironment, `update upstream branches for '${projectName}/${alias}'`);
    }
    if (tagRefspecs.length > 0) {
      await runGit([
        "--git-dir", gitDirectory,
        "push", "--atomic", prepared.managedUrl,
        ...tagRefspecs
      ], managedEnvironment, `update tags for '${projectName}/${alias}'`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function pushRepository(projectName: string, alias: string, refspecs: string[]): Promise<void> {
  for (const refspec of refspecs) {
    const [source, destination, extra] = refspec.split(":");
    if (extra !== undefined || !source || !destination || source.startsWith("+")) {
      throw new UserError(`repo push requires non-forced source:destination refspecs; invalid refspec '${refspec}'`);
    }
    if (!isBranchOrTagRef(source) || !isBranchOrTagRef(destination)) {
      throw new UserError(`repo push accepts only full branch or tag refs; invalid refspec '${refspec}'`);
    }
  }
  const prepared = await adminCall<PreparedRepositorySync>("repo.sync-prepare", {
    project: projectName,
    alias
  });
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-repo-push-"));
  const gitDirectory = path.join(temporary, "sync.git");
  try {
    await runGit(["init", "--bare", gitDirectory], process.env, "initialize temporary repository");
    const sourceRefs = [...new Set(refspecs.map((refspec) => {
      const source = refspec.slice(0, refspec.indexOf(":"));
      return `${source}:${source}`;
    }))];
    await runGit([
      "--git-dir", gitDirectory,
      "fetch", prepared.managedUrl,
      ...sourceRefs
    ], managedGitEnvironment(prepared), `read managed repository '${projectName}/${alias}'`);
    const externalRefspecs = refspecs.map((refspec) => {
      const separator = refspec.indexOf(":");
      const source = refspec.slice(0, separator);
      const destination = refspec.slice(separator + 1);
      return `${source}:${mapRepositoryRefToExternal(prepared.refNamespace, destination)}`;
    });
    await runGit([
      "--git-dir", gitDirectory,
      "push", prepared.externalUrl,
      ...externalRefspecs
    ], process.env, `push external repository '${projectName}/${alias}'`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function managedGitEnvironment(prepared: PreparedRepositorySync): NodeJS.ProcessEnv {
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  return {
    ...process.env,
    DIM_GIT_USERNAME: prepared.writerUsername,
    DIM_GIT_TOKEN: prepared.writerPassword,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: helper
  };
}

function isBranchOrTagRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/");
}

async function runGit(args: string[], env: NodeJS.ProcessEnv, action: string): Promise<void> {
  const exitCode = await runner.runStreaming("git", args, { env });
  if (exitCode !== 0) throw new UserError(`failed to ${action}: git exited with code ${exitCode}`);
}

async function localRefs(gitDirectory: string, prefix: string): Promise<string[]> {
  const result = await runner.run("git", [
    "--git-dir", gitDirectory,
    "for-each-ref", "--format=%(refname)", prefix
  ], { env: process.env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect fetched refs");
  return result.stdout.split("\n").map((ref) => ref.trim()).filter(Boolean);
}

async function materializeExternalRefs(
  gitDirectory: string,
  namespace: RepositoryRefNamespace | undefined,
  upstreamBranches: boolean
): Promise<void> {
  const result = await runner.run("git", [
    "--git-dir", gitDirectory,
    "for-each-ref", "--format=%(objectname) %(refname)", "refs/dim-external"
  ], { env: process.env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect external refs");
  for (const line of result.stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf(" ");
    const objectId = line.slice(0, separator);
    const stagingRef = line.slice(separator + 1);
    const externalRef = stagingRef.startsWith("refs/dim-external/heads/")
      ? `refs/heads/${stagingRef.slice("refs/dim-external/heads/".length)}`
      : `refs/tags/${stagingRef.slice("refs/dim-external/tags/".length)}`;
    const repositoryRef = mapExternalRefToRepository(namespace, externalRef);
    if (repositoryRef === undefined) continue;
    const targetRef = upstreamBranches && repositoryRef.startsWith("refs/heads/")
      ? `refs/heads/upstream/${repositoryRef.slice("refs/heads/".length)}`
      : repositoryRef;
    await runGit(
      ["--git-dir", gitDirectory, "update-ref", targetRef, objectId],
      process.env,
      `map external ref '${externalRef}'`
    );
  }
}

async function remoteRefs(url: string, pattern: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await runner.run("git", ["ls-remote", "--refs", url, pattern], { env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect managed upstream refs");
  return result.stdout.split("\n")
    .map((line) => line.trim().split(/\s+/, 2)[1])
    .filter((ref): ref is string => ref !== undefined);
}

async function readRepositorySetFile(file: string): Promise<RepositorySet> {
  const absolute = path.resolve(file);
  return parseRepositorySetYaml(await readFile(absolute, "utf8"), absolute);
}

async function readRemoteRepositorySet(url: string, ref?: string): Promise<RepositorySet> {
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-root-manifest-"));
  const gitDirectory = path.join(temporary, "source.git");
  try {
    await runGit(["init", "--bare", gitDirectory], process.env, "initialize root manifest checkout");
    await runGit(
      ["--git-dir", gitDirectory, "fetch", "--depth=1", "--no-tags", url, ref ?? "HEAD"],
      process.env,
      `read root manifest from '${url}'`
    );
    const shown = await runner.run("git", [
      "--git-dir", gitDirectory,
      "show", "FETCH_HEAD:.dim/repos.yml"
    ], { env: process.env });
    if (shown.exitCode !== 0) {
      const selected = ref ?? "HEAD";
      throw new UserError(
        `remote '${url}' ref '${selected}' does not contain .dim/repos.yml; provide --root ALIAS for a manifest-free repository`
      );
    }
    return parseRepositorySetYaml(shown.stdout, `${url}:${ref ?? "HEAD"}:.dim/repos.yml`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createOrResumeRootProject(name: string, alias: string, source: string | undefined): Promise<void> {
  try {
    await adminCall("project.create", { name });
    return;
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes(`project '${name}' already exists`)) throw error;
  }
  const project = await adminCall<{
    rootRepositoryAlias?: string;
    repositories: Array<{
      alias: string;
      phase: string;
      connections: Array<{ name: string; url: string }>;
    }>;
  }>("project.show", { name });
  const root = project.repositories.find((repository) => repository.alias === alias);
  const origin = root?.connections.find((connection) => connection.name === "origin")?.url;
  if (project.rootRepositoryAlias !== alias || root === undefined || root.phase === "ready" || origin !== source) {
    throw new UserError(`project '${name}' already exists`);
  }
  console.error(`Retrying failed root repository import for project '${name}'`);
}

async function resolveRepositorySet(projectName: string, file?: string): Promise<RepositorySet> {
  if (file !== undefined) return readRepositorySetFile(file);
  const response = await adminCall<{ found: boolean; repositorySet?: RepositorySet }>("repo.root-set", {
    project: projectName
  });
  if (!response.found || !response.repositorySet) {
    throw new UserError(`project '${projectName}' root does not contain .dim/repos.yml`);
  }
  return response.repositorySet;
}

async function repositorySetPlan(
  projectName: string,
  set: RepositorySet,
  createProject: boolean
): Promise<RepositorySetPlan> {
  return adminCall("repo.plan", { project: projectName, createProject, repositorySet: set });
}

async function approveRepositoryPlan(plan: RepositorySetPlan, yes: boolean, show = true): Promise<void> {
  const changed = plan.actions.filter(({ action }) => action !== "unchanged");
  if (show) {
    for (const action of plan.actions) {
      const source = action.entry.url
        ?? (action.entry.upstream === undefined ? "(empty)" : `upstream:${action.entry.upstream}`);
      console.log(`${action.action}\t${action.alias}\t${source}${action.detail ? `\t${action.detail}` : ""}`);
    }
  }
  const conflicts = plan.actions.filter(({ action }) => action === "conflict");
  if (conflicts.length > 0) {
    throw new UserError(`repository plan has ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`);
  }
  if (changed.length === 0 || yes) return;
  if (!interactive()) throw new UserError("repository changes require --yes in a non-interactive shell");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("Apply this repository plan? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new UserError("repository plan was not applied");
  } finally {
    prompt.close();
  }
}

async function applyRepositorySet(
  projectName: string,
  set: RepositorySet,
  plan: RepositorySetPlan
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const action of plan.actions) {
    if (action.action === "unchanged") continue;
    if (action.action === "conflict") throw new UserError(`repository '${action.alias}' conflicts with existing state`);
    results.push(await addRepository(projectName, action.alias, action.entry, set));
  }
  return results;
}

async function addRepository(
  projectName: string,
  alias: string,
  entry: RepositorySetEntry & { mirror?: boolean },
  set?: RepositorySet
): Promise<Record<string, unknown>> {
  const connection = set === undefined
    ? (entry.url === undefined ? undefined : { url: entry.url })
    : resolveRepositoryConnection(set, alias);
  const prepared = await adminCall<PreparedRepositoryTransfer>("repo.prepare", {
    project: projectName,
    alias,
    root: entry.root,
    protectedPatterns: entry.protectedPatterns,
    ...(connection === undefined ? {} : {
      source: connection.url,
      ...(connection.refNamespace === undefined ? {} : { refNamespace: connection.refNamespace })
    }),
    ...(entry.rootRef === undefined ? {} : { rootRef: entry.rootRef })
  });
  if (!prepared.transferId || !prepared.sourceUrl) return prepared.repository;
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-repo-transfer-"));
  const mirror = path.join(temporary, "source.git");
  try {
    let exitCode = await runner.runStreaming("git", ["init", "--bare", mirror], { env: process.env });
    if (exitCode === 0) {
      exitCode = await runner.runStreaming("git", [
        "--git-dir", mirror,
        "fetch", "--no-tags", prepared.sourceUrl,
        ...(entry.mirror
          ? ["+refs/*:refs/*"]
          : ["+refs/heads/*:refs/dim-external/heads/*", "+refs/tags/*:refs/dim-external/tags/*"])
      ], { env: process.env });
    }
    if (exitCode === 0 && !entry.mirror) {
      await materializeExternalRefs(mirror, connection?.refNamespace, false);
    }
    if (exitCode === 0) {
      if (!prepared.writerUsername || !prepared.writerPassword) {
        throw new UserError("controller did not provide managed Git transfer credentials");
      }
      const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
      const importedRefs = entry.mirror
        ? []
        : [
            ...(await localRefs(mirror, "refs/heads")).map((ref) => `${ref}:${ref}`),
            ...(await localRefs(mirror, "refs/tags")).map((ref) => `${ref}:${ref}`)
          ];
      if (!entry.mirror && importedRefs.length === 0) {
        throw new UserError(`external repository '${projectName}/${alias}' contains no branches or tags`);
      }
      exitCode = await runner.runStreaming("git", [
        "--git-dir", mirror,
        "-c", "credential.helper=",
        "-c", `credential.helper=${helper}`,
        "push",
        ...(entry.mirror ? ["--mirror"] : []),
        prepared.targetUrl,
        ...importedRefs
      ], {
        env: {
          ...process.env,
          DIM_GIT_USERNAME: prepared.writerUsername,
          DIM_GIT_TOKEN: prepared.writerPassword,
          GIT_TERMINAL_PROMPT: "0"
        }
      });
    }
    if (exitCode !== 0) {
      await adminCall("repo.complete", {
        project: projectName,
        alias,
        transferId: prepared.transferId,
        success: false,
        error: `git transfer exited with code ${exitCode}`
      });
      throw new UserError(`failed to import repository '${projectName}/${alias}'`);
    }
    return await adminCall<Record<string, unknown>>("repo.complete", {
      project: projectName,
      alias,
      transferId: prepared.transferId,
      success: true
    });
  } catch (error) {
    if (!(error instanceof UserError && error.message.startsWith("failed to import repository"))) {
      await adminCall("repo.complete", {
        project: projectName,
        alias,
        transferId: prepared.transferId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function offerRootRepositorySet(projectName: string, apply: boolean | undefined): Promise<void> {
  const response = await adminCall<{ found: boolean; repositorySet?: RepositorySet }>("repo.root-set", {
    project: projectName
  });
  if (!response.found || !response.repositorySet) return;
  const count = Object.keys(response.repositorySet.repositories).length;
  const later = `Apply it later without a local clone: dim repo apply ${projectName} --yes`;
  if (apply) {
    const plan = await repositorySetPlan(projectName, response.repositorySet, false);
    await approveRepositoryPlan(plan, true);
    await applyRepositorySet(projectName, response.repositorySet, plan);
    return;
  }
  if (apply === false) {
    console.error(`Root contains .dim/repos.yml with ${count} repositories; it was not applied. ${later}`);
    return;
  }
  if (!interactive()) {
    console.error(`Root contains .dim/repos.yml with ${count} repositories; it was not applied. ${later}`);
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(
      `Root contains .dim/repos.yml with ${count} repositories. Apply it? [y/N] `
    )).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.error(later);
      return;
    }
  } finally {
    prompt.close();
  }
  const plan = await repositorySetPlan(projectName, response.repositorySet, false);
  await approveRepositoryPlan(plan, true);
  await applyRepositorySet(projectName, response.repositorySet, plan);
}

async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

function hasResourceFlags(flags: ResourceFlags): boolean {
  return flags.cpus !== undefined || flags.memory !== undefined || flags.processes !== undefined;
}

function ciExecutor(value: string): "sysbox" | "qemu" {
  if (value !== "sysbox" && value !== "qemu") throw new UserError("CI executor must be 'sysbox' or 'qemu'");
  return value;
}

function resourceInput(flags: ResourceFlags): { cpus?: string; memory?: string; pidsLimit?: string } {
  return {
    ...(flags.cpus === undefined ? {} : { cpus: flags.cpus }),
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.processes === undefined ? {} : { pidsLimit: flags.processes })
  };
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

function cliPort(value: string, flag: string, zero: boolean): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (zero ? 0 : 1) || port > 65_535) {
    throw new UserError(`${flag} must be between ${zero ? 0 : 1} and 65535`);
  }
  return port;
}

async function externalUrlControllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  return controllerRequest(pathname, init, workspace);
}

async function adminCall<T = unknown>(
  operation: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const options = lifecycleOptions();
  await ensureManagedController(options);
  const response = await unixHttpRequest(
    options.adminControllerSocketPath,
    `/v1/call/${encodeURIComponent(operation)}`,
    { method: "POST", body: JSON.stringify(body) }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new UserError(
      `admin controller request failed (${response.status})${response.body ? `: ${response.body.trim()}` : ""}`
    );
  }
  return (response.status === 204 || response.body.length === 0 ? {} : JSON.parse(response.body)) as T;
}

async function externalUrlAdmin<T = unknown>(
  action: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const options = lifecycleOptions();
  await ensureManagedController(options);
  const response = await unixHttpRequest(
    options.adminControllerSocketPath,
    `/v1/external-url/${encodeURIComponent(action)}`,
    { method: "POST", body: JSON.stringify(body) }
  );
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) {
      throw new UserError(
        "External URL commands require the @slop-lab/dim-plugin-external-urls plugin; install it and restart the controller"
      );
    }
    const detail = externalUrlErrorDetail(response.body);
    throw new UserError(
      `External URL admin request failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  return (response.status === 204 || response.body.length === 0 ? {} : JSON.parse(response.body)) as T;
}

function externalUrlErrorDetail(body: string): string {
  if (body.length === 0) return "";
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Preserve a non-JSON response from the controller for diagnostics.
  }
  return body.trim();
}

async function controllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  let socketPath = process.env.DIM_CONTROLLER_SOCKET;
  let api = process.env.DIM_CONTROLLER_API;
  let token = process.env.DIM_CONTROLLER_TOKEN;
  if (workspace) {
    const options = lifecycleOptions();
    socketPath ??= options.controllerSocketPath;
    try {
      token = (await readFile(path.join(options.stateRoot, "workspace-grants", workspace), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UserError(`workspace '${workspace}' has no controller grant`);
      }
      throw error;
    }
  }
  if ((!socketPath && !api) || !token) {
    throw new UserError(
      "DIM_CONTROLLER_SOCKET and DIM_CONTROLLER_TOKEN are required inside a workspace; use --workspace on the host"
    );
  }
  if (socketPath) {
    const response = await unixHttpRequest(socketPath, pathname, init, token);
    if (response.status < 200 || response.status >= 300) {
      throw new UserError(
        `controller request failed (${response.status})${response.body ? `: ${response.body.trim()}` : ""}`
      );
    }
    if (response.status === 204) return {};
    return JSON.parse(response.body) as unknown;
  }
  const response = await fetch(new URL(pathname, api), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new UserError(`external URL controller request failed (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
  }
  if (response.status === 204) return {};
  return await response.json() as unknown;
}

async function unixHttpRequest(
  socketPath: string,
  pathname: string,
  init: RequestInit,
  token?: string
): Promise<{ status: number; body: string }> {
  const body = typeof init.body === "string" ? init.body : undefined;
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      path: pathname,
      method: init.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

const managedControllerStartAttempts = 2400;

async function ensureManagedController(options: LifecycleOptions): Promise<void> {
  if (await managedControllerReady(options)) return;
  if (usesSystemdManagedController(options)) {
    await startSystemdManagedController(options);
    return;
  }
  const runtimeDir = path.dirname(options.controllerSocketPath);
  const lockDir = path.join(runtimeDir, "ensure.lock");
  await mkdir(runtimeDir, { recursive: true });
  let ownsLock = false;
  for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
    try {
      await mkdir(lockDir);
      ownsLock = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await managedControllerReady(options)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!ownsLock) {
    await rm(lockDir, { recursive: true, force: true });
    return ensureManagedController(options);
  }
  try {
    if (await managedControllerReady(options)) return;
    await rm(options.controllerSocketPath, { force: true });
    await rm(options.adminControllerSocketPath, { force: true });
    const log = await open(path.join(runtimeDir, "controller.log"), "a");
    const script = process.argv[1];
    if (!script) throw new UserError("cannot locate the DIM CLI entrypoint");
    const child = spawn(process.execPath, [
      ...process.execArgv,
      script,
      "controller",
      "serve",
      "--socket",
      options.controllerSocketPath,
      "--admin-socket",
      options.adminControllerSocketPath
    ], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: process.env
    });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
      if (await managedControllerReady(options)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new UserError(`managed controller failed to start; see ${path.join(runtimeDir, "controller.log")}`);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function managedControllerReady(options: LifecycleOptions): Promise<boolean> {
  if (!await controllersHealthy(options)) return false;
  try {
    const value = await readFile(path.join(path.dirname(options.controllerSocketPath), "controller.pid"), "utf8");
    const pid = Number(value.trim());
    return Number.isSafeInteger(pid) && pid > 1 && processExists(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function controllersHealthy(options: LifecycleOptions): Promise<boolean> {
  return await controllerHealthy(options.controllerSocketPath)
    && await controllerHealthy(options.adminControllerSocketPath);
}

async function controllerHealthy(socketPath: string): Promise<boolean> {
  try {
    const response = await unixHttpRequest(socketPath, "/healthz", {}, undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

async function claimControllerPid(pidPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(pidPath, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingPid: number | undefined;
      try {
        existingPid = Number((await readFile(pidPath, "utf8")).trim());
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
        continue;
      }
      if (Number.isSafeInteger(existingPid) && existingPid > 1 && processExists(existingPid)) {
        throw new UserError(`managed controller process ${existingPid} is already running`);
      }
      await rm(pidPath, { force: true });
    }
  }
  throw new UserError(`could not claim managed controller PID file at ${pidPath}`);
}

async function pidFileOwnedByCurrentProcess(pidPath: string): Promise<boolean> {
  try {
    return Number((await readFile(pidPath, "utf8")).trim()) === process.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function prepareControllerSocket(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  if (await unixSocketAcceptingConnections(socketPath)) {
    throw new UserError(`controller socket is already in use at ${socketPath}`);
  }
  await rm(socketPath, { force: true });
}

async function unixSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

async function closeControllerServer(
  server: ReturnType<typeof configuredDimController> | undefined
): Promise<void> {
  if (!server?.listening) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

async function stopManagedController(options: LifecycleOptions): Promise<void> {
  if (usesSystemdManagedController(options)) {
    const result = await runner.run("systemctl", ["--user", "stop", "dim-controller.service"]);
    if (result.exitCode !== 0 && !result.stderr.includes("not loaded")) {
      throw new UserError(`could not stop DIM controller: ${result.stderr.trim()}`);
    }
    return;
  }
  try {
    const value = await readFile(path.join(path.dirname(options.controllerSocketPath), "controller.pid"), "utf8");
    const pid = Number(value.trim());
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
}

async function restartManagedController(options: LifecycleOptions): Promise<void> {
  if (usesSystemdManagedController(options)) {
    await startSystemdManagedController(options);
    return;
  }
  let pid: number | undefined;
  try {
    const value = await readFile(path.join(path.dirname(options.controllerSocketPath), "controller.pid"), "utf8");
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 1) pid = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await stopManagedController(options);
  for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
    if (pid === undefined || !processExists(pid)) {
      await rm(options.controllerSocketPath, { force: true });
      await rm(options.adminControllerSocketPath, { force: true });
      await ensureManagedController(options);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    if (pid !== undefined) process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (pid !== undefined) {
    for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processExists(pid)) throw new UserError(`managed controller process ${pid} did not stop`);
  }
  await rm(options.controllerSocketPath, { force: true });
  await rm(options.adminControllerSocketPath, { force: true });
  await ensureManagedController(options);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function usesSystemdManagedController(options: LifecycleOptions): boolean {
  if (process.platform !== "linux") return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const systemdRuntimeRoot = `/run/user/${uid}`;
  if ((process.env.XDG_RUNTIME_DIR ?? systemdRuntimeRoot) !== systemdRuntimeRoot) return false;
  const defaultStateRoot = path.resolve(path.join(homedir(), ".local/state/dim"));
  const runtimeDirectory = path.join(systemdRuntimeRoot, "dim");
  return options.stateRoot === defaultStateRoot
    && options.controllerSocketPath === path.join(runtimeDirectory, "controller.sock")
    && options.adminControllerSocketPath === path.join(runtimeDirectory, "admin.sock");
}

async function startSystemdManagedController(options: LifecycleOptions): Promise<void> {
  const script = process.argv[1];
  if (!script) throw new UserError("cannot locate the DIM CLI entrypoint");
  const unitDirectory = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
    "systemd",
    "user"
  );
  const unitPath = path.join(unitDirectory, "dim-controller.service");
  const environment = [
    "DIM_CONFIG_PATH",
    "DIM_DATA_HOME",
    "DIM_INSTALL_PREFIX",
    "DIM_PLUGIN_HOME",
    "DIM_EXTERNAL_URL_CONFIG",
    "DOCKER_HOST",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME"
  ].flatMap((name) => process.env[name] === undefined
    ? []
    : [`Environment=${systemdQuote(`${name}=${process.env[name]}`)}`]);
  const command = [
    process.execPath,
    ...process.execArgv,
    script,
    "controller",
    "serve",
    "--socket",
    options.controllerSocketPath,
    "--admin-socket",
    options.adminControllerSocketPath
  ].map(systemdQuote).join(" ");
  const unit = `[Unit]
Description=DIM managed controller

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=1s
KillMode=control-group
RuntimeDirectory=dim
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=restart
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dim-controller
${environment.join("\n")}

[Install]
WantedBy=default.target
`;
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.tmp-${process.pid}`;
  await writeFile(temporary, unit, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, unitPath);
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "dim-controller.service"],
    ["--user", "restart", "dim-controller.service"]
  ]) {
    const result = await runner.run("systemctl", args);
    if (result.exitCode !== 0) {
      throw new UserError(
        `could not start DIM controller with systemd: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
  }
  for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
    if (await managedControllerReady(options)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new UserError(
    "managed controller failed to start; run "
      + "'journalctl --user --unit dim-controller.service --lines 100' for details"
  );
}

function systemdQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new UserError("systemd controller arguments must not contain newlines");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

main();

async function main(): Promise<void> {
  try {
    if (process.platform !== "linux") {
      throw new UserError(`DIM requires a Linux host; unsupported platform '${process.platform}'`);
    }
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
