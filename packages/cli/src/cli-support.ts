import { once } from "node:events";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { Command, type AddHelpTextContext } from "commander";
import {
  configuredDimAdminController,
  configuredDimController,
  configuredWorkspaceBackend,
  inspectWorkspaceBackends,
  lifecycleOptions,
  lifecycleOptionsForBackend,
  type LifecycleOptions,
  loadInstalledPlugins,
  ProcessRunner,
  parseRepositorySetYaml,
  mapExternalRefToRepository,
  mapRepositoryRefToExternal,
  normalizeRootRef,
  resolveRepositoryConnection,
  type RepositoryRefNamespace,
  type RepositorySet,
  type RepositorySetEntry,
  initializeControllerRoutes,
  resolvePluginHome,
  runDoctor,
  runtimeBackendChecks,
  setConfiguredWorkspaceBackend,
  UserError,
  type WorkspaceRuntimeBackendKind,
} from "@slop-lab/dim-core";

export const runner = new ProcessRunner();

export interface RepoFlags {
  root?: boolean;
  ref?: string;
  protect?: string;
  json?: boolean;
}

export interface JsonFlags {
  json?: boolean;
}

export interface ResourceFlags {
  cpus?: string;
  memory?: string;
  processes?: string;
}

export interface WorkspaceCreateFlags extends JsonFlags {
  profile: string[];
  kvm?: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
  cpus?: string;
  memory?: string;
  processes?: string;
}

export interface DnsProviderAddFlags {
  name: string;
}

export interface IngressAddFlags {
  name: string;
  description: string;
  scheme: "http" | "https";
}

export interface ExternalUrlCreateFlags extends JsonFlags {
  ingress: string;
  subdomain?: string;
  container: string[];
  port: string;
  protocol: "http" | "https";
  path?: string;
  workspace?: string;
}

export interface WorkspaceControllerFlags extends JsonFlags {
  workspace?: string;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function commaSeparated(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new UserError("--protect must contain at least one pattern");
  return values;
}

export function installerFacadeHelpText(program: Command): (context: AddHelpTextContext) => string {
  return (context: AddHelpTextContext): string => {
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
  };
}

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function confirmAction(yes: boolean, question: string): Promise<void> {
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

export async function confirmRecommended(question: string): Promise<boolean> {
  if (!interactive()) throw new UserError("recommended confirmation requires an interactive shell");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    throw new UserError("answer must be yes or no");
  } finally {
    prompt.close();
  }
}

export function parseWorkspaceBackend(value: string): WorkspaceRuntimeBackendKind {
  if (value === "sysbox" || value === "gvisor" || value === "rootless-podman" || value === "runc") {
    return value;
  }
  throw new UserError("backend must be sysbox, gvisor, rootless-podman, or runc");
}

export async function selectInstalledWorkspaceBackend(): Promise<WorkspaceRuntimeBackendKind> {
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

export function printDoctorChecks(checks: Array<{ name: string; ok: boolean; detail: string }>): void {
  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
  }
}

export interface RepositorySetPlan {
  project: string;
  createProject: boolean;
  actions: Array<{
    action: "create" | "retry" | "unchanged" | "conflict";
    alias: string;
    entry: RepositorySetEntry;
    detail?: string;
  }>;
}

export interface PreparedRepositoryTransfer {
  transferId?: string;
  repository: Record<string, unknown>;
  sourceUrl?: string;
  targetUrl: string;
  writerUsername?: string;
  writerPassword?: string;
}

export interface PreparedRepositorySync {
  externalUrl: string;
  refNamespace?: RepositoryRefNamespace;
  managedUrl: string;
  writerUsername: string;
  writerPassword: string;
  publishBranches: Record<string, string>;
}

export async function fetchRepository(projectName: string, alias: string, prune: boolean): Promise<void> {
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

export async function publishRepositories(projectName: string, alias?: string): Promise<string[]> {
  const aliases = alias === undefined
    ? (await adminCall<Array<{ alias: string; connections: Array<{ publishBranches?: Record<string, string> }> }>>(
        "repo.list", { project: projectName }
      )).filter((repository) => repository.connections.some(
        (connection) => Object.keys(connection.publishBranches ?? {}).length > 0
      )).map((repository) => repository.alias)
    : [alias];
  if (aliases.length === 0) throw new UserError(`project '${projectName}' has no repositories configured for publish`);
  for (const repositoryAlias of aliases) await publishRepository(projectName, repositoryAlias);
  return aliases;
}

async function publishRepository(projectName: string, alias: string): Promise<void> {
  const prepared = await adminCall<PreparedRepositorySync>("repo.sync-prepare", {
    project: projectName,
    alias
  });
  const refspecs = Object.entries(prepared.publishBranches).map(([source, destination]) =>
    `refs/heads/${source}:refs/heads/${destination}`
  );
  if (refspecs.length === 0) throw new UserError(`repo '${projectName}/${alias}' has no publish policy`);
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

export function managedGitEnvironment(prepared: PreparedRepositorySync): NodeJS.ProcessEnv {
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

export function isBranchOrTagRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/");
}

export async function runGit(args: string[], env: NodeJS.ProcessEnv, action: string): Promise<void> {
  const exitCode = await runner.runStreaming("git", args, { env });
  if (exitCode !== 0) throw new UserError(`failed to ${action}: git exited with code ${exitCode}`);
}

export async function localRefs(gitDirectory: string, prefix: string): Promise<string[]> {
  const result = await runner.run("git", [
    "--git-dir", gitDirectory,
    "for-each-ref", "--format=%(refname)", prefix
  ], { env: process.env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect fetched refs");
  return result.stdout.split("\n").map((ref) => ref.trim()).filter(Boolean);
}

export async function materializeExternalRefs(
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

export async function remoteRefs(url: string, pattern: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await runner.run("git", ["ls-remote", "--refs", url, pattern], { env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect managed upstream refs");
  return result.stdout.split("\n")
    .map((line) => line.trim().split(/\s+/, 2)[1])
    .filter((ref): ref is string => ref !== undefined);
}

export async function readRepositorySetFile(file: string): Promise<RepositorySet> {
  const absolute = path.resolve(file);
  return parseRepositorySetYaml(await readFile(absolute, "utf8"), absolute);
}

export async function readRemoteRepositorySet(url: string, ref?: string): Promise<RepositorySet> {
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

export async function createOrResumeRootProject(name: string, alias: string, source: string | undefined): Promise<void> {
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

export async function resolveRepositorySet(projectName: string, file?: string): Promise<RepositorySet> {
  if (file !== undefined) return readRepositorySetFile(file);
  const response = await adminCall<{ found: boolean; repositorySet?: RepositorySet }>("repo.root-set", {
    project: projectName
  });
  if (!response.found || !response.repositorySet) {
    throw new UserError(`project '${projectName}' root does not contain .dim/repos.yml`);
  }
  return response.repositorySet;
}

export async function repositorySetPlan(
  projectName: string,
  set: RepositorySet,
  createProject: boolean
): Promise<RepositorySetPlan> {
  return adminCall("repo.plan", { project: projectName, createProject, repositorySet: set });
}

export async function approveRepositoryPlan(plan: RepositorySetPlan, yes: boolean, show = true): Promise<void> {
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

export async function applyRepositorySet(
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

export async function addRepository(
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
      ...(connection.refNamespace === undefined ? {} : { refNamespace: connection.refNamespace }),
      ...(connection.publishBranches === undefined ? {} : { publishBranches: connection.publishBranches })
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

export async function offerRootRepositorySet(projectName: string, apply: boolean | undefined): Promise<void> {
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

export async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

export function hasResourceFlags(flags: ResourceFlags): boolean {
  return flags.cpus !== undefined || flags.memory !== undefined || flags.processes !== undefined;
}

export function ciExecutor(value: string): "sysbox" | "qemu" {
  if (value !== "sysbox" && value !== "qemu") throw new UserError("CI executor must be 'sysbox' or 'qemu'");
  return value;
}

export function resourceInput(flags: ResourceFlags): { cpus?: string; memory?: string; pidsLimit?: string } {
  return {
    ...(flags.cpus === undefined ? {} : { cpus: flags.cpus }),
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.processes === undefined ? {} : { pidsLimit: flags.processes })
  };
}

export function print(value: unknown, flags: JsonFlags = {}): void {
  if (flags.json || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

export function printList<T extends object>(records: T[], fields: string[], flags: JsonFlags = {}): void {
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

export function cliPort(value: string, flag: string, zero: boolean): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (zero ? 0 : 1) || port > 65_535) {
    throw new UserError(`${flag} must be between ${zero ? 0 : 1} and 65535`);
  }
  return port;
}

export async function externalUrlControllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  return controllerRequest(pathname, init, workspace);
}

export async function adminCall<T = unknown>(
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

export async function externalUrlAdmin<T = unknown>(
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

export function externalUrlErrorDetail(body: string): string {
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

export async function controllerRequest(
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

export async function unixHttpRequest(
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

export async function ensureManagedController(options: LifecycleOptions): Promise<void> {
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

export async function managedControllerReady(options: LifecycleOptions): Promise<boolean> {
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

export async function controllersHealthy(options: LifecycleOptions): Promise<boolean> {
  return await controllerHealthy(options.controllerSocketPath)
    && await controllerHealthy(options.adminControllerSocketPath);
}

export async function controllerHealthy(socketPath: string): Promise<boolean> {
  try {
    const response = await unixHttpRequest(socketPath, "/healthz", {}, undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function claimControllerPid(pidPath: string): Promise<void> {
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

export async function pidFileOwnedByCurrentProcess(pidPath: string): Promise<boolean> {
  try {
    return Number((await readFile(pidPath, "utf8")).trim()) === process.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareControllerSocket(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  if (await unixSocketAcceptingConnections(socketPath)) {
    throw new UserError(`controller socket is already in use at ${socketPath}`);
  }
  await rm(socketPath, { force: true });
}

export async function unixSocketAcceptingConnections(socketPath: string): Promise<boolean> {
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

export async function closeControllerServer(
  server: ReturnType<typeof configuredDimController> | undefined
): Promise<void> {
  if (!server?.listening) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

export async function stopManagedController(options: LifecycleOptions): Promise<void> {
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

export async function restartManagedController(options: LifecycleOptions): Promise<void> {
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

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function usesSystemdManagedController(options: LifecycleOptions): boolean {
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

export async function startSystemdManagedController(options: LifecycleOptions): Promise<void> {
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

export function systemdQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new UserError("systemd controller arguments must not contain newlines");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
