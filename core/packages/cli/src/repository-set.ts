import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import {
  parseRepositorySetYaml,
  resolveRepositoryConnection,
  UserError,
  type LongOperationOptions,
  type RepositorySet
} from "@slop-lab/dim-core";
import { adminCall } from "./controller-client.js";
import { interactive, runner } from "./cli-runtime.js";
import { withLocalProgress } from "./local-progress.js";
import { applyRepositorySet } from "./repository-transfer.js";
import { runGit } from "./repository-sync.js";
import { type RepositorySetPlan } from "./repository-set-types.js";

export type { RepositorySetPlan } from "./repository-set-types.js";

export async function readRepositorySetFile(file: string): Promise<RepositorySet> {
  const absolute = path.resolve(file);
  return parseRepositorySetYaml(await readFile(absolute, "utf8"), absolute);
}

export async function readRemoteRepositorySet(
  url: string,
  ref?: string,
  operation: LongOperationOptions = {}
): Promise<RepositorySet> {
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-root-manifest-"));
  const gitDirectory = path.join(temporary, "source.git");
  try {
    await runGit(
      ["init", "--bare", gitDirectory],
      process.env,
      "initialize root manifest checkout",
      operation
    );
    await runGit(
      ["--git-dir", gitDirectory, "fetch", "--depth=1", "--no-tags", url, ref ?? "HEAD"],
      process.env,
      `read root manifest from '${url}'`,
      operation
    );
    const shown = await runner.run("git", [
      "--git-dir", gitDirectory,
      "show", "FETCH_HEAD:.dim/repos.yml"
    ], {
      env: process.env,
      ...(operation.signal === undefined ? {} : { signal: operation.signal })
    });
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

export async function createOrResumeRootProject(
  name: string,
  alias: string,
  source: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  try {
    await adminCall("project.create", { name }, signal);
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
  }>("project.show", { name }, signal);
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
  createProject: boolean,
  rebindOrigin?: string
): Promise<RepositorySetPlan> {
  return adminCall("repo.plan", {
    project: projectName,
    createProject,
    repositorySet: set,
    ...(rebindOrigin === undefined ? {} : { rebindOrigin })
  });
}

export async function approveRepositoryPlan(plan: RepositorySetPlan, yes: boolean, show = true): Promise<void> {
  const changed = plan.actions.filter(({ action }) => action !== "unchanged");
  if (show) {
    for (const action of plan.actions) {
      const source = action.entry.url
        ?? (action.entry.upstream === undefined ? "(empty)" : `upstream:${action.entry.upstream}`);
      console.log(`${action.action}\t${action.alias}\t${source}${action.detail ? `\t${action.detail}` : ""}`);
    }
    for (const alias of plan.preservedAliases ?? []) {
      console.log(`preserve\t${alias}\t(existing repository omitted from manifest)`);
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

export async function offerRootRepositorySet(projectName: string, apply: boolean | undefined): Promise<void> {
  const response = await adminCall<{ found: boolean; repositorySet?: RepositorySet }>("repo.root-set", {
    project: projectName
  });
  if (!response.found || !response.repositorySet) return;
  const repositorySet = response.repositorySet;
  const count = Object.keys(repositorySet.repositories).length;
  const later = `Apply it later without a local clone: dim repo apply ${projectName} --yes`;
  const origins = new Set(Object.keys(repositorySet.repositories)
    .map((alias) => resolveRepositoryConnection(repositorySet, alias)?.url)
    .filter((url): url is string => url !== undefined));
  const sameOriginSet = origins.size <= 1;
  if (apply || (apply === undefined && sameOriginSet)) {
    const plan = await repositorySetPlan(projectName, repositorySet, false);
    await approveRepositoryPlan(plan, true);
    await withLocalProgress("repo.apply", (operation) => {
      operation.reportProgress("repository set apply");
      return applyRepositorySet(projectName, repositorySet, plan, undefined, operation);
    });
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
  const plan = await repositorySetPlan(projectName, repositorySet, false);
  await approveRepositoryPlan(plan, true);
  await withLocalProgress("repo.apply", (operation) => {
    operation.reportProgress("repository set apply");
    return applyRepositorySet(projectName, repositorySet, plan, undefined, operation);
  });
}
