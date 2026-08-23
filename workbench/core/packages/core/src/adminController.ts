import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyProjectRepositoryProtection,
  createProject,
  listProjectRepositories,
  listProjects,
  planProjectRepositorySet,
  prepareHostGitCredential,
  prepareProjectRepositorySync,
  prepareProjectRepositoryTransfer,
  completeProjectRepositoryTransfer,
  readProjectRootRepositorySetYaml,
  projectRepositoryHostUrl,
  projectRepositoryWorkspaceUrl,
  purgeProject,
  deleteProjectRepository,
  removeProject,
  showProject,
  showProjectRepository
} from "./projectRegistry.js";
import {
  alignWorkspaceRoot,
  createWorkspace,
  discardWorkspace,
  listWorkspaces,
  restartWorkspace,
  setupWorkspace,
  showWorkspace,
  startWorkspace,
  stopWorkspace,
  updateWorkspace,
  updateWorkspaceResources
} from "./workspaceLifecycle.js";
import { ensureGitea } from "./gitea.js";
import { runDoctor } from "./doctor.js";
import type { CiRunnerExecutorKind, LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { ProcessRunner } from "./runner.js";
import type { StreamingCommandRunner } from "./types.js";
import { isUserError, UserError } from "./errors.js";
import {
  parseRepositorySetYaml,
  assertRepositorySetUrlsArePortable,
  validateRepositoryRefNamespace,
  validateRepositorySet
} from "./repositorySet.js";
import {
  createCiRunner,
  deleteCiRunner,
  listCiRunners,
  restartCiRunner,
  showCiRunner,
  startCiRunner,
  stopCiRunner
} from "./ciRunner.js";

export interface AdminRouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly request: IncomingMessage;
  readonly lifecycle: LifecycleOptions;
  readonly runner: StreamingCommandRunner;
  readJson(maxBytes?: number): Promise<unknown>;
}

export interface DimAdminRoute {
  readonly method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  readonly path: string;
  readonly summary: string;
  readonly plugin?: string;
  handle(context: AdminRouteContext): Promise<{ status?: number; body?: unknown } | void>;
}

export function configuredDimAdminController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Server {
  return createServer((request, response) => {
    void handleAdminRequest(lifecycle, plugins, runner, request, response).catch((error) => {
      sendJson(response, isUserError(error) ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

async function handleAdminRequest(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dim-admin");
  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, apiVersion: 1 });
  }
  if (request.method === "GET" && url.pathname === "/v1") {
    return sendJson(response, 200, {
      apiVersion: 1,
      routes: plugins.adminRoutes.map(({ method, path, summary, plugin }) => ({
        method,
        path: `/v1${path}`,
        summary,
        ...(plugin ? { plugin } : {})
      }))
    });
  }
  if (request.method === "POST" && url.pathname.startsWith("/v1/call/")) {
    const operation = decodeURIComponent(url.pathname.slice("/v1/call/".length));
    const body = await readJson(request, 65_536);
    return sendJson(response, 200, await builtinCall(operation, record(body), lifecycle, runner, plugins));
  }
  for (const route of plugins.adminRoutes) {
    if (route.method !== request.method) continue;
    const params = matchRoute(route.path, url.pathname);
    if (!params) continue;
    const result = await route.handle({
      params,
      request,
      lifecycle,
      runner,
      readJson: (limit = 65_536) => readJson(request, limit)
    });
    if (!result) return void response.writeHead(204).end();
    if (result.body === undefined) return void response.writeHead(result.status ?? 204).end();
    return sendJson(response, result.status ?? 200, result.body);
  }
  sendJson(response, 404, { error: "not found" });
}

async function builtinCall(
  operation: string,
  input: Record<string, unknown>,
  lifecycle: LifecycleOptions,
  runner: StreamingCommandRunner,
  plugins: RegisteredDimPlugins
): Promise<unknown> {
  const text = (name: string) => {
    const value = input[name];
    if (typeof value !== "string") throw new UserError(`${name} must be a string`);
    return value;
  };
  switch (operation) {
    case "project.create": return createProject(runner, lifecycle, text("name"));
    case "project.list": return listProjects(lifecycle);
    case "project.show": return showProject(lifecycle, text("name"));
    case "project.remove": await removeProject(lifecycle, text("name")); return {};
    case "project.purge": await purgeProject(runner, lifecycle, text("name")); return {};
    case "repo.plan":
      return planProjectRepositorySet(
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
            publishBranches: input.publishBranches ?? {},
            ...(input.source === undefined ? {} : { url: text("source") }),
            ...(input.rootRef === undefined ? {} : { rootRef: text("rootRef") })
          }
        }
      });
      const entry = repositorySet.repositories[alias]!;
      return prepareProjectRepositoryTransfer(runner, lifecycle, {
        project: text("project"),
        alias,
        root: entry.root,
        protectedPatterns: entry.protectedPatterns,
        ...(entry.url === undefined ? {} : { source: entry.url }),
        ...(input.refNamespace === undefined
          ? {}
          : { refNamespace: validateRepositoryRefNamespace(input.refNamespace, "refNamespace") }),
        publishBranches: entry.publishBranches,
        ...(entry.rootRef === undefined ? {} : { rootRef: entry.rootRef })
      });
    }
    case "repo.complete":
      return completeProjectRepositoryTransfer(
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
      return prepareProjectRepositorySync(runner, lifecycle, text("project"), text("alias"));
    case "repo.root-set": {
      const yaml = await readProjectRootRepositorySetYaml(runner, lifecycle, text("project"));
      if (yaml === undefined) return { found: false };
      const repositorySet = parseRepositorySetYaml(yaml, ".dim/repos.yml");
      assertRepositorySetUrlsArePortable(repositorySet, ".dim/repos.yml");
      return { found: true, repositorySet };
    }
    case "repo.list": return listProjectRepositories(lifecycle, text("project"));
    case "repo.show": return showProjectRepository(lifecycle, text("project"), text("alias"));
    case "repo.delete":
      await deleteProjectRepository(runner, lifecycle, text("project"), text("alias"));
      return {};
    case "repo.protect": return applyProjectRepositoryProtection(runner, lifecycle, text("project"), text("alias"));
    case "repo.url":
      return {
        url: input.workspace === true
          ? await projectRepositoryWorkspaceUrl(lifecycle, text("project"), text("alias"))
          : await projectRepositoryHostUrl(lifecycle, text("project"), text("alias"))
      };
    case "ci.runner.create":
      return createCiRunner(runner, lifecycle, {
        project: text("project"),
        name: text("name"),
        executor: ciExecutor(input.executor),
        ...(input.resources === undefined ? {} : { resources: ciResources(input.resources) })
      });
    case "ci.runner.list": return listCiRunners(lifecycle);
    case "ci.runner.show": return showCiRunner(lifecycle, text("project"), text("name"));
    case "ci.runner.start": return startCiRunner(runner, lifecycle, { project: text("project"), name: text("name") });
    case "ci.runner.restart": return restartCiRunner(runner, lifecycle, { project: text("project"), name: text("name") });
    case "ci.runner.stop": return stopCiRunner(runner, lifecycle, text("project"), text("name"));
    case "ci.runner.delete": await deleteCiRunner(runner, lifecycle, text("project"), text("name")); return {};
    case "workspace.create":
      return createWorkspace(runner, lifecycle, {
        project: text("project"),
        name: text("name"),
        profiles: stringArray(input.profiles),
        runtimeBackend: text("runtimeBackend") as WorkspaceRuntimeBackendKind,
        cpuCount: text("cpuCount"),
        memory: text("memory"),
        pidsLimit: text("pidsLimit"),
        ...(input.kvm === undefined ? {} : { kvm: booleanValue(input.kvm) }),
        ...(input.gitUserName === undefined ? {} : { gitUserName: text("gitUserName") }),
        ...(input.gitUserEmail === undefined ? {} : { gitUserEmail: text("gitUserEmail") })
      });
    case "workspace.list": return listWorkspaces(lifecycle);
    case "workspace.show": return showWorkspace(lifecycle, text("name"));
    case "workspace.align": return alignWorkspaceRoot(runner, lifecycle, text("name"), input.reset === true);
    case "workspace.setup": return setupWorkspace(runner, lifecycle, text("name"));
    case "workspace.update":
      return updateWorkspace(
        runner,
        lifecycle,
        text("name"),
        input.profiles === undefined ? undefined : stringArray(input.profiles)
      );
    case "workspace.resources":
      return updateWorkspaceResources(runner, lifecycle, text("name"), {
        ...(input.cpuCount === undefined ? {} : { cpuCount: text("cpuCount") }),
        ...(input.memory === undefined ? {} : { memory: text("memory") }),
        ...(input.pidsLimit === undefined ? {} : { pidsLimit: text("pidsLimit") })
      });
    case "workspace.start": return startWorkspace(runner, lifecycle, text("name"));
    case "workspace.restart": return restartWorkspace(runner, lifecycle, text("name"));
    case "workspace.stop": await stopWorkspace(runner, lifecycle, text("name")); return {};
    case "workspace.discard": await discardWorkspace(runner, lifecycle, text("name")); return {};
    case "doctor": return runDoctor(runner, lifecycle.defaultWorkspaceBackend, lifecycle);
    case "service.ensure": return ensureGitea(runner, lifecycle);
    case "git.credentials": return prepareHostGitCredential(runner, lifecycle);
    case "git.setup": {
      await prepareHostGitCredential(runner, lifecycle);
      const baseUrl = `http://127.0.0.1:${lifecycle.giteaPort}`;
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

function ciResources(value: unknown): { cpus?: string; memory?: string; pidsLimit?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("resources must be an object");
  const input = value as Record<string, unknown>;
  const result: { cpus?: string; memory?: string; pidsLimit?: string } = {};
  for (const key of ["cpus", "memory", "pidsLimit"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || input[key].length === 0) throw new UserError(`resources.${key} must be a string`);
      result[key] = input[key];
    }
  }
  return result;
}

function matchRoute(routePath: string, requestPath: string): Record<string, string> | undefined {
  const expected = `/v1${routePath}`.split("/");
  const actual = requestPath.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index] ?? "";
    const value = actual[index] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return undefined;
  }
  return params;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new UserError(`request body exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new UserError("request body must be valid JSON");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UserError("expected an array of strings");
  }
  return value as string[];
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new UserError("expected a boolean");
  return value;
}

function ciExecutor(value: unknown): CiRunnerExecutorKind {
  if (value !== "sysbox" && value !== "qemu") throw new UserError("CI executor must be 'sysbox' or 'qemu'");
  return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
