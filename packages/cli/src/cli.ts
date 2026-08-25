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
  configuredDimAgentController,
  configuredDimController,
  configuredWorkspaceBackend,
  detectWorkspaceKvm,
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
  normalizeRepositoryRef,
  resolveRepositoryConnection,
  type RepositoryRefNamespace,
  type RepositorySet,
  type RepositorySetEntry,
  initializeControllerRoutes,
  resolvePluginHome,
  runCommonDoctorChecks,
  runDoctor,
  runtimeBackendChecks,
  setConfiguredWorkspaceBackend,
  configuredCiRunnerDefaults,
  setConfiguredCiRunnerDefaults,
  BUILTIN_CI_RUNNER_DEFAULTS,
  UserError,
  type WorkspaceRuntimeBackendKind,
} from "@slop-lab/dim-core";
import {
  addRepository,
  adminCall,
  adminStreamCall,
  applyRepositorySet,
  approveRepositoryPlan,
  ciExecutor,
  claimControllerPid,
  cliPort,
  closeControllerServer,
  collect,
  commaSeparated,
  confirmAction,
  confirmRecommended,
  controllerRequest,
  createOrResumeRootProject,
  ensureManagedController,
  externalUrlAdmin,
  externalUrlControllerRequest,
  fetchRepository,
  hasResourceFlags,
  interactive,
  installerFacadeHelpText,
  offerRootRepositorySet,
  parseWorkspaceBackend,
  print,
  printDoctorChecks,
  printList,
  prepareControllerSocket,
  publishRepositories,
  readRemoteRepositorySet,
  readRepositorySetFile,
  readStdin,
  repositorySetPlan,
  resolveRepositorySet,
  resourceInput,
  restartManagedController,
  runner,
  selectInstalledWorkspaceBackend,
  pidFileOwnedByCurrentProcess,
  startSystemdManagedController,
  stopManagedController,
  type DnsProviderAddFlags,
  type ExternalUrlCreateFlags,
  type IngressAddFlags,
  type JsonFlags,
  type RepoFlags,
  type ResourceFlags,
  type WorkspaceControllerFlags,
  type WorkspaceCreateFlags,
} from "./cli-support.js";

const program = new Command();

program
  .name("dim")
  .description("Isolated, persistent development workspaces")
  .version("0.8.0")
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("afterAll", installerFacadeHelpText(program));

const project = program.command("project").description("Manage project metadata and Git namespaces");

project.command("create")
  .description("Create a project and its managed Git namespace")
  .argument("<project>")
  .option("--repos <file>", "create and populate from a repos.yml file")
  .option("--root <alias>", "import or create the root repository with this alias")
  .option("--bootstrap-git-url <git-url>", "discover .dim/repos.yml and import its root from this Git repository")
  .option("--bootstrap-git-ref <git-ref>", "external bootstrap Git ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--mirror", "import every root ref instead of only branches and tags")
  .option("--apply-repos", "apply the root .dim/repos.yml without prompting")
  .option("--no-apply-repos", "do not apply the root .dim/repos.yml")
  .option("--yes", "apply the repository plan without prompting")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags & {
    repos?: string;
    root?: string;
    bootstrapGitUrl?: string;
    bootstrapGitRef?: string;
    protect?: string;
    applyRepos?: boolean;
    mirror?: boolean;
    yes?: boolean;
  }) => {
    const rootOptionsPresent = flags.root !== undefined || flags.bootstrapGitUrl !== undefined || flags.bootstrapGitRef !== undefined
      || flags.protect !== undefined
      || flags.mirror !== undefined
      || flags.applyRepos !== undefined;
    if (flags.repos !== undefined && rootOptionsPresent) {
      throw new UserError("--repos cannot be combined with root repository options");
    }
    if (flags.root === undefined && flags.bootstrapGitUrl === undefined && rootOptionsPresent) {
      throw new UserError("--root or --bootstrap-git-url is required with --bootstrap-git-ref or repository apply options");
    }
    if (flags.root === undefined && (flags.protect !== undefined || flags.mirror !== undefined)) {
      throw new UserError("--protect and --mirror require --root; manifest bootstrap reads root policy from .dim/repos.yml");
    }
    if (process.argv.includes("--apply-repos") && process.argv.includes("--no-apply-repos")) {
      throw new UserError("--apply-repos and --no-apply-repos cannot be used together");
    }
    if (flags.repos === undefined && flags.root === undefined && flags.bootstrapGitUrl === undefined) {
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
      rootSet = await readRemoteRepositorySet(flags.bootstrapGitUrl!, flags.bootstrapGitRef);
      assertRepositorySetCanCreateProject(rootSet, `${flags.bootstrapGitUrl!}:.dim/repos.yml`);
      [rootAlias] = Object.entries(rootSet.repositories).find(([, entry]) => entry.root)!;
      const connection = resolveRepositoryConnection(rootSet, rootAlias);
      if (connection?.url !== flags.bootstrapGitUrl) {
        throw new UserError(
          `remote manifest root '${rootAlias}' URL '${connection?.url ?? "(empty)"}' does not match bootstrap Git URL '${flags.bootstrapGitUrl}'`
        );
      }
    }
    const rootEntry = rootSet?.repositories[rootAlias];
    const rootConnection = rootSet === undefined || rootAlias === undefined
      ? undefined
      : resolveRepositoryConnection(rootSet, rootAlias);
    const externalManifestRootRef = rootEntry?.ref === undefined
      ? undefined
      : mapRepositoryRefToExternal(rootConnection?.refNamespace, rootEntry.ref);
    if (flags.bootstrapGitRef !== undefined && externalManifestRootRef !== undefined
      && normalizeRepositoryRef(flags.bootstrapGitRef) !== normalizeRepositoryRef(externalManifestRootRef)) {
      throw new UserError(
        `--bootstrap-git-ref '${flags.bootstrapGitRef}' conflicts with manifest external root ref '${externalManifestRootRef}' for '${rootAlias}'`
      );
    }
    const selectedRootRef = rootEntry?.ref ?? flags.bootstrapGitRef;
    await createOrResumeRootProject(name, rootAlias, flags.bootstrapGitUrl);
    const repository = await addRepository(name, rootAlias, {
      ...(flags.bootstrapGitUrl === undefined ? {} : { url: flags.bootstrapGitUrl }),
      fallback: rootEntry?.fallback ?? false,
      root: true,
      ...(selectedRootRef === undefined ? {} : { ref: selectedRootRef }),
      protectedPatterns: rootEntry?.protectedPatterns
        ?? (flags.protect === undefined ? [] : commaSeparated(flags.protect)),
      forcePushBlockedPatterns: rootEntry?.forcePushBlockedPatterns ?? [],
      importBranches: rootEntry?.importBranches ?? {},
      publishBranches: rootEntry?.publishBranches ?? {},
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
      ...(flags.ref === undefined ? {} : { ref: flags.ref }),
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      forcePushBlockedPatterns: [],
      importBranches: {},
      publishBranches: {},
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
    printList(await adminCall<Record<string, unknown>[]>("repo.list", { project: name }), ["alias", "phase", "ref", "hostUrl", "workspaceUrl"], flags)
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

repo.command("publish")
  .description("Publish configured branches for one repository or the whole project")
  .argument("<project>")
  .argument("[alias]")
  .action(async (projectName: string, alias?: string) => {
    const published = await publishRepositories(projectName, alias);
    for (const item of published) console.log(item);
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
  .option("--pids <count>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, executor: string, flags: ResourceFlags & JsonFlags) => {
    executor = ciExecutor(executor);
    if (executor === "qemu" && flags.pids !== undefined) throw new UserError("--pids applies only to the sysbox executor");
    print(await adminStreamCall("ci.runner.create", {
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
    print(await adminStreamCall("ci.runner.restart", { project, name }), flags));

ciRunner.command("start")
  .description("Start a stopped named CI runner")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminStreamCall("ci.runner.start", { project, name }), flags));

ciRunner.command("stop")
  .description("Stop a named CI runner without deleting its local data")
  .argument("<project>")
  .argument("<runner>")
  .option("--json", "print machine-readable JSON")
  .action(async (project: string, name: string, flags: JsonFlags) =>
    print(await adminStreamCall("ci.runner.stop", { project, name }), flags)
  );

ciRunner.command("logs")
  .description("Follow project CI runner logs")
  .argument("<project>")
  .argument("<runner>")
  .action(async (project: string, name: string) => {
    const result = await adminStreamCall<{ exitCode: number }>("ci.runner.logs", { project, name });
    process.exitCode = result.exitCode;
  });

ciRunner.command("delete")
  .description("Remove a named CI runner and its local data")
  .argument("<project>")
  .argument("<runner>")
  .option("--yes", "confirm runner and local data deletion")
  .action(async (project: string, name: string, flags: { yes?: boolean }) => {
    await confirmAction(flags.yes ?? false, `Permanently delete CI runner '${project}/${name}' and its local data?`);
    await adminStreamCall("ci.runner.delete", { project, name });
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
  .requiredOption("--pids <count>")
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
    print(await adminStreamCall("workspace.create", {
      project: projectName,
      name,
      profiles: flags.profile,
      repositoryRefs: flags.repoRef,
      runtimeBackend: options.defaultWorkspaceBackend,
      cpuCount: flags.cpus ?? options.cpuCount,
      memory: flags.memory ?? options.memory,
      pidsLimit: flags.pids ?? options.pidsLimit,
      ...(kvm === undefined ? {} : { kvm }),
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
  .option("--pids <count>", "workspace PID limit")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: ResourceFlags & JsonFlags) => {
    if (!hasResourceFlags(flags)) throw new UserError("provide at least one resource limit");
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminStreamCall("workspace.resources", {
      name,
      ...(flags.cpus === undefined ? {} : { cpuCount: flags.cpus }),
      ...(flags.memory === undefined ? {} : { memory: flags.memory }),
      ...(flags.pids === undefined ? {} : { pidsLimit: flags.pids })
    }), flags);
  });

program.command("exec")
  .description("Execute a raw command in a running workspace")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.exec", {
      name,
      command,
      interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

program.command("run")
  .description("Run a root project task through .dim/entrypoint.sh")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.run", {
      name,
      command: task,
      interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

workspace.command("exec")
  .description("Execute a raw command in a running workspace")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.exec", {
      name, command, interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

workspace.command("run")
  .description("Run a root project task through .dim/entrypoint.sh")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    const result = await adminStreamCall<{ exitCode: number }>("workspace.run", {
      name, command: task, interactive: interactive()
    }, { stdin: true, terminal: interactive() });
    process.exitCode = result.exitCode;
  });

workspace.command("align")
  .description("Align the root checkout to its configured ref without running setup")
  .argument("<workspace>")
  .option("--reset", "reset the configured local branch to the fetched ref")
  .option("--yes", "confirm resetting local commits on the configured branch")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags & { reset?: boolean; yes?: boolean }) => {
    if (flags.reset && !flags.yes) throw new UserError("--reset requires --yes");
    print(await adminStreamCall("workspace.align", { name, reset: flags.reset ?? false }), flags);
  });

workspace.command("setup")
  .description("Retry root project environment setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminStreamCall("workspace.setup", { name }), flags);
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
    print(await adminStreamCall("workspace.update", {
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
    print(await adminStreamCall("workspace.start", { name }), flags);
  });

workspace.command("restart")
  .description("Restart a workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await adminStreamCall("workspace.restart", { name }), flags);
  });

workspace.command("stop")
  .description("Stop a workspace while preserving its checkout and inner-engine data")
  .argument("<workspace>")
  .action(async (name: string) => void await adminStreamCall("workspace.stop", { name }));

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
    await adminStreamCall("workspace.discard", { name });
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
  .argument("[driver-argument...]", "arguments interpreted by the selected plugin driver")
  .requiredOption("--name <name>")
  .allowUnknownOption()
  .action(async (driver: string, driverArguments: string[], flags: DnsProviderAddFlags) => {
    await externalUrlAdmin("dns-provider-add", {
      driver,
      name: flags.name,
      arguments: driverArguments
    });
    console.log(`Configured external URL DNS provider '${flags.name}'`);
  });

const externalUrlIngress = externalUrl.command("ingress").description("Manage host-shared ingresses");

externalUrlIngress.command("add")
  .description("Add or replace a named external URL ingress")
  .argument("<driver>")
  .argument("[driver-argument...]", "arguments interpreted by the selected plugin driver")
  .requiredOption("--name <name>")
  .requiredOption("--description <text>")
  .requiredOption("--scheme <scheme>", "http or https")
  .allowUnknownOption()
  .action(async (driver: string, driverArguments: string[], flags: IngressAddFlags) => {
    if (flags.scheme !== "http" && flags.scheme !== "https") throw new UserError("--scheme must be http or https");
    await externalUrlAdmin("ingress-add", {
      driver,
      name: flags.name,
      description: flags.description,
      scheme: flags.scheme,
      arguments: driverArguments
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
  .option("--agent-socket <path>", "listen for agent-safe workspace APIs on a Unix socket")
  .option("--pid-file <path>", "record the managed controller process ID")
  .option("--host <host>", "listen address for explicit TCP mode")
  .option("--port <port>", "listen port for explicit TCP mode")
  .action(async (flags: { socket?: string; adminSocket?: string; agentSocket?: string; pidFile?: string; host?: string; port?: string }) => {
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
    const agentSocket = flags.socket
      ? flags.agentSocket ?? options.agentControllerSocketPath
      : undefined;
    const pidPath = flags.socket
      ? flags.pidFile ?? path.join(path.dirname(flags.socket), "controller.pid")
      : undefined;
    let ownsPid = false;
    let loaded: Awaited<ReturnType<typeof loadInstalledPlugins>> | undefined;
    let server: ReturnType<typeof configuredDimController> | undefined;
    let adminServer: ReturnType<typeof configuredDimAdminController> | undefined;
    let agentServer: ReturnType<typeof configuredDimAgentController> | undefined;
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
      agentServer = configuredDimAgentController(options, loaded.registered);
      if (flags.socket && adminSocket && agentSocket) {
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
        await prepareControllerSocket(agentSocket);
        const agentListening = once(agentServer, "listening");
        agentServer.listen(agentSocket);
        await agentListening;
        await chmod(agentSocket, 0o666);
        console.log(`DIM workspace controller listening on ${flags.socket}`);
        console.log(`DIM agent controller listening on ${agentSocket}`);
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
            closeControllerServer(agentServer),
            closeControllerServer(adminServer)
          ]);
        } finally {
          if (ownsPid && pidPath && await pidFileOwnedByCurrentProcess(pidPath)) {
            if (flags.socket) await rm(flags.socket, { force: true });
            if (agentSocket) await rm(agentSocket, { force: true });
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
  .description("Run Git with the managed host-maintainer credential")
  .argument("<args...>")
  .allowUnknownOption(true)
  .action(async (args: string[]) => {
    const credentials = await adminCall<{ username: string; password: string }>("git.credentials");
    const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
    process.exitCode = await runner.runStreaming("git", ["-c", `credential.helper=${helper}`, ...args], {
      env: {
        ...process.env,
        DIM_GIT_USERNAME: credentials.username,
        DIM_GIT_TOKEN: credentials.password,
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
    const credentials = await adminCall<{ username: string; password: string }>("git.credentials");
    console.log(`username=${credentials.username}`);
    console.log(`password=${credentials.password}`);
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
