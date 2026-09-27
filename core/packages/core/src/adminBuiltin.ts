import * as ciRunner from "./ciRunner.js";
import { runDoctor } from "./doctor.js";
import { UserError } from "./errors.js";
import { ensureGitea } from "./gitea.js";
import { HostNotReadyError, withHostAdminAdmission, withHostRuntimeAdmission } from "./hostAdminAdmission.js";
import { hostLifecycleStatus, shutdownHost, startHost } from "./hostLifecycle.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import * as projectRegistry from "./projectRegistry.js";
import { assertRepositorySetUrlsArePortable, parseRepositorySetYaml, validateRepositoryRefNamespace, validateRepositorySet } from "./repositorySet.js";
import type { StreamingCommandRunner } from "./types.js";
import * as workspaceLifecycle from "./workspaceLifecycle.js";
import { booleanValue, ciExecutor, ciResources, stringArray, stringValue, workspaceRuntimeBackend } from "./adminInput.js";

type BuiltinContext = {
  readonly input: Record<string, unknown>;
  readonly lifecycle: LifecycleOptions;
  readonly runner: StreamingCommandRunner;
  readonly plugins: RegisteredDimPlugins;
};

export async function adminBuiltinCall(operation: string, context: BuiltinContext): Promise<unknown> {
  switch (operation) {
    case "host.status":
      return hostLifecycleStatus(context.lifecycle);
    case "host.shutdown":
      return shutdownHost(context.runner, context.lifecycle);
    case "host.start":
      return startHost(context.runner, context.lifecycle);
    default:
      try {
        const admit = RUNTIME_OPERATIONS.has(operation) ? withHostRuntimeAdmission : withHostAdminAdmission;
        return await admit(context.lifecycle, () => dispatchBuiltin(operation, context));
      } catch (error) {
        if (error instanceof HostNotReadyError) {
          throw new UserError(`DIM host is ${error.phase}; run dim host start before '${operation}'`);
        }
        throw error;
      }
  }
}

const RUNTIME_OPERATIONS = new Set(["ci.runner.logs", "workspace.exec", "workspace.run"]);

async function dispatchBuiltin(operation: string, context: BuiltinContext): Promise<unknown> {
  const { input, lifecycle, runner, plugins } = context;
  const text = (name: string) => stringValue(input[name], name);
  switch (operation) {
    case "project.create": return projectRegistry.createProject(runner, lifecycle, text("name"));
    case "project.list": return projectRegistry.listProjects(lifecycle);
    case "project.show": return projectRegistry.showProject(lifecycle, text("name"));
    case "project.remove": await projectRegistry.removeProject(lifecycle, text("name")); return {};
    case "project.purge": await projectRegistry.purgeProject(runner, lifecycle, text("name")); return {};
    case "repo.plan":
      return projectRegistry.planProjectRepositorySet(
        lifecycle,
        text("project"),
        validateRepositorySet(input.repositorySet),
        input.createProject === true
      );
    case "repo.prepare": {
      const alias = text("alias");
      const repositorySet = validateRepositorySet({
        schemaVersion: 1,
        upstreams: {},
        repositories: {
          [alias]: {
            root: input.root === true,
            fallback: false,
            protectedPatterns: stringArray(input.protectedPatterns),
            forcePushBlockedPatterns: stringArray(input.forcePushBlockedPatterns),
            importBranches: {},
            publishBranches: input.publishBranches ?? {},
            ...(input.source === undefined ? {} : { url: text("source") }),
            ...(input.ref === undefined ? {} : { ref: text("ref") })
          }
        }
      });
      const entry = repositorySet.repositories[alias];
      if (entry === undefined) throw new UserError(`repository alias '${alias}' is missing`);
      return projectRegistry.prepareProjectRepositoryTransfer(runner, lifecycle, {
        project: text("project"),
        alias,
        root: entry.root,
        protectedPatterns: entry.protectedPatterns,
        forcePushBlockedPatterns: entry.forcePushBlockedPatterns,
        ...(entry.url === undefined ? {} : { source: entry.url }),
        ...(input.refNamespace === undefined
          ? {}
          : { refNamespace: validateRepositoryRefNamespace(input.refNamespace, "refNamespace") }),
        publishBranches: entry.publishBranches,
        ...(entry.ref === undefined ? {} : { ref: entry.ref })
      });
    }
    case "repo.complete":
      return projectRegistry.completeProjectRepositoryTransfer(
        runner,
        lifecycle,
        text("project"),
        text("alias"),
        text("transferId"),
        {
          success: input.success === true,
          ...(input.error === undefined ? {} : { error: text("error") })
        }
      );
    case "repo.sync-prepare":
      return projectRegistry.prepareProjectRepositorySync(runner, lifecycle, text("project"), text("alias"));
    case "repo.root-set": {
      const yaml = await projectRegistry.readProjectRootRepositorySetYaml(runner, lifecycle, text("project"));
      if (yaml === undefined) return { found: false };
      const repositorySet = parseRepositorySetYaml(yaml, ".dim/repos.yml");
      assertRepositorySetUrlsArePortable(repositorySet, ".dim/repos.yml");
      return { found: true, repositorySet };
    }
    case "repo.list": return projectRegistry.listProjectRepositories(lifecycle, text("project"));
    case "repo.show": return projectRegistry.showProjectRepository(lifecycle, text("project"), text("alias"));
    case "repo.delete":
      await projectRegistry.deleteProjectRepository(runner, lifecycle, text("project"), text("alias"));
      return {};
    case "repo.protect":
      return projectRegistry.applyProjectRepositoryProtection(runner, lifecycle, text("project"), text("alias"));
    case "repo.url":
      return {
        url: input.workspace === true
          ? await projectRegistry.projectRepositoryWorkspaceUrl(lifecycle, text("project"), text("alias"))
          : await projectRegistry.projectRepositoryHostUrl(lifecycle, text("project"), text("alias"))
      };
    case "ci.runner.create":
      return ciRunner.createCiRunner(runner, lifecycle, {
        project: text("project"),
        name: text("name"),
        executor: ciExecutor(input.executor),
        ...(input.resources === undefined ? {} : { resources: ciResources(input.resources) })
      });
    case "ci.runner.list": return ciRunner.listCiRunners(lifecycle);
    case "ci.runner.show": return ciRunner.showCiRunner(lifecycle, text("project"), text("name"));
    case "ci.runner.logs": {
      const record = await ciRunner.showCiRunner(lifecycle, text("project"), text("name"));
      const container = record.executor.kind === "sysbox"
        ? record.executor.containerName
        : record.executor.supervisorName;
      return { exitCode: await runner.runStreaming("docker", ["logs", "--follow", container]) };
    }
    case "ci.runner.start": return ciRunner.startCiRunner(runner, lifecycle, { project: text("project"), name: text("name") });
    case "ci.runner.restart": return ciRunner.restartCiRunner(runner, lifecycle, { project: text("project"), name: text("name") });
    case "ci.runner.stop": return ciRunner.stopCiRunner(runner, lifecycle, text("project"), text("name"));
    case "ci.runner.delete": await ciRunner.deleteCiRunner(runner, lifecycle, text("project"), text("name")); return {};
    case "workspace.create":
      if (input.repositoryRefs !== undefined) {
        throw new UserError("workspace repository ref overrides are obsolete; define non-root ref policy in reviewed Project code");
      }
      return workspaceLifecycle.createWorkspace(runner, lifecycle, {
        project: text("project"),
        name: text("name"),
        profiles: stringArray(input.profiles),
        requiredCapabilities: stringArray(input.requiredCapabilities),
        recommendedCapabilities: stringArray(input.recommendedCapabilities),
        runtimeBackend: workspaceRuntimeBackend(input.runtimeBackend),
        cpuCount: text("cpuCount"),
        memory: text("memory"),
        pidsLimit: text("pidsLimit"),
        ...(input.kvm === undefined ? {} : { kvm: booleanValue(input.kvm) }),
        ...(input.gitUserName === undefined ? {} : { gitUserName: text("gitUserName") }),
        ...(input.gitUserEmail === undefined ? {} : { gitUserEmail: text("gitUserEmail") })
      }, plugins);
    case "workspace.list": return workspaceLifecycle.listWorkspaces(runner, lifecycle);
    case "workspace.show": return workspaceLifecycle.showWorkspace(runner, lifecycle, text("name"));
    case "workspace.setup": return workspaceLifecycle.setupWorkspace(runner, lifecycle, text("name"));
    case "workspace.update":
      return workspaceLifecycle.updateWorkspace(
        runner,
        lifecycle,
        text("name"),
        input.profiles === undefined ? undefined : stringArray(input.profiles)
      );
    case "workspace.resources":
      return workspaceLifecycle.updateWorkspaceResources(runner, lifecycle, text("name"), {
        ...(input.cpuCount === undefined ? {} : { cpuCount: text("cpuCount") }),
        ...(input.memory === undefined ? {} : { memory: text("memory") }),
        ...(input.pidsLimit === undefined ? {} : { pidsLimit: text("pidsLimit") })
      });
    case "workspace.start": return workspaceLifecycle.startWorkspace(runner, lifecycle, text("name"));
    case "workspace.restart": return workspaceLifecycle.restartWorkspace(runner, lifecycle, text("name"));
    case "workspace.exec": return {
      exitCode: await workspaceLifecycle.execWorkspace(runner, lifecycle, {
        name: text("name"),
        command: stringArray(input.command),
        interactive: input.interactive === true
      })
    };
    case "workspace.run": return {
      exitCode: await workspaceLifecycle.runWorkspace(runner, lifecycle, {
        name: text("name"),
        command: stringArray(input.command),
        interactive: input.interactive === true
      })
    };
    case "workspace.stop": await workspaceLifecycle.stopWorkspace(runner, lifecycle, text("name")); return {};
    case "workspace.discard":
      await workspaceLifecycle.discardWorkspace(
        runner,
        lifecycle,
        text("name"),
        input.keepVolume === true,
        plugins.workspaceDiscardHooks
      );
      return {};
    case "doctor": return runDoctor(runner, lifecycle.defaultWorkspaceBackend, lifecycle);
    case "service.ensure": return ensureGitea(runner, lifecycle);
    case "git.credentials": return projectRegistry.prepareHostGitCredential(runner, lifecycle);
    case "git.setup": {
      const { baseUrl } = await projectRegistry.prepareHostGitCredential(runner, lifecycle);
      const helper = await runner.run("git", [
        "config", "--global", "--replace-all",
        `credential.${baseUrl}.helper`,
        "!dim git credential-helper"
      ]);
      if (helper.exitCode !== 0) throw new UserError(`failed to configure Git credential helper: ${helper.stderr.trim()}`);
      const usePath = await runner.run("git", [
        "config", "--global", "--replace-all",
        `credential.${baseUrl}.useHttpPath`,
        "true"
      ]);
      if (usePath.exitCode !== 0) throw new UserError(`failed to configure Git credential path matching: ${usePath.stderr.trim()}`);
      return { baseUrl };
    }
    case "plugin.list":
      return {
        plugins: plugins.plugins.filter((name) => !name.startsWith("builtin.")),
        controllerRoutes: plugins.controllerRoutes.map((route) => `${route.method} /api${route.path}`),
        adminRoutes: plugins.adminRoutes.map((route) => `${route.method} /v1${route.path}`)
      };
    default: throw new UserError(`unknown admin operation '${operation}'`);
  }
}

export const STREAMABLE_OPERATIONS = new Set([
  "project.create", "project.purge", "repo.protect", "ci.runner.create", "ci.runner.logs",
  "ci.runner.start", "ci.runner.restart", "ci.runner.stop", "ci.runner.delete",
  "workspace.create", "workspace.setup", "workspace.update",
  "workspace.resources", "workspace.start", "workspace.restart", "workspace.stop",
  "workspace.discard", "workspace.exec", "workspace.run", "service.ensure",
  "host.shutdown", "host.start", "doctor"
]);
