import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../errors.js";
import { ensureGitea } from "../gitea.js";
import { validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions } from "../lifecycleTypes.js";
import type { CommandRunner } from "../types.js";
import { commandError, gitCredentialEnvironment } from "./helpers.js";
import { showProject, showProjectRepository } from "./queries.js";

export async function readProjectRootRepositorySetYaml(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string
): Promise<string | undefined> {
  const project = await showProject(options, validateLifecycleName(projectNameInput, "project"));
  if (!project.rootRepositoryAlias) throw new UserError(`project '${project.name}' has no root repository`);
  const repository = await showProjectRepository(options, project.name, project.rootRepositoryAlias);
  const credentials = await ensureGitea(runner, options);
  const temporary = await mkdtemp(join(tmpdir(), "dim-root-manifest-"));
  const gitDirectory = join(temporary, "root.git");
  try {
    const cloned = await runner.run("git", ["clone", "--mirror", repository.hostUrl, gitDirectory], {
      env: gitCredentialEnvironment(credentials)
    });
    if (cloned.exitCode !== 0) throw commandError(`read root repository '${project.name}'`, cloned);
    const ref = project.rootRef ?? "HEAD";
    const shown = await runner.run("git", ["--git-dir", gitDirectory, "show", `${ref}:.dim/repos.yml`]);
    if (shown.exitCode === 0) return shown.stdout;
    if (/does not exist|exists on disk, but not in|invalid object name|unknown revision|bad object/i.test(shown.stderr)) {
      return undefined;
    }
    throw commandError(`read ${ref}:.dim/repos.yml`, shown);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readProjectRootFile(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string,
  file: string
): Promise<string | undefined> {
  if (!file.startsWith(".dim/") || file.includes("..")) {
    throw new UserError("Project root file must be below .dim");
  }
  const project = await showProject(options, validateLifecycleName(projectNameInput, "project"));
  if (!project.rootRepositoryAlias) throw new UserError(`project '${project.name}' has no root repository`);
  const repository = await showProjectRepository(options, project.name, project.rootRepositoryAlias);
  const credentials = await ensureGitea(runner, options);
  const temporary = await mkdtemp(join(tmpdir(), "dim-root-file-"));
  const gitDirectory = join(temporary, "root.git");
  try {
    const cloned = await runner.run("git", ["clone", "--mirror", repository.hostUrl, gitDirectory], {
      env: gitCredentialEnvironment(credentials)
    });
    if (cloned.exitCode !== 0) throw commandError(`read root repository '${project.name}'`, cloned);
    const ref = project.rootRef ?? "HEAD";
    const shown = await runner.run("git", ["--git-dir", gitDirectory, "show", `${ref}:${file}`]);
    if (shown.exitCode === 0) return shown.stdout;
    if (/does not exist|exists on disk, but not in|invalid object name|unknown revision|bad object/i.test(shown.stderr)) {
      return undefined;
    }
    throw commandError(`read ${ref}:${file}`, shown);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
