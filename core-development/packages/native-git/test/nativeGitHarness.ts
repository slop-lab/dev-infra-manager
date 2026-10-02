import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createNativeGitServer,
  initializeNativeRepository,
  type NativeGitIdentity,
  type NativeGitRepository,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";

const run = promisify(execFile);
const gitExecutable = "/usr/bin/git";
const gitVersion = "2.43.0";

export type NativeGitFixture = {
  readonly root: string;
  readonly baseUrl: string;
  readonly config: NativeGitServiceConfig;
  readonly repositoryPath: (projectId: string, repositoryId: string) => string;
  readonly url: (username: string, password: string, projectId: string, repositoryId: string) => string;
  readonly git: (cwd: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly close: () => Promise<void>;
};

export async function nativeGitFixture(): Promise<NativeGitFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-git-"));
  const storageRoot = join(root, "storage");
  const repositories = [
    { projectId: "project-a", repositoryId: "source" },
    { projectId: "project-b", repositoryId: "source" }
  ] as const satisfies readonly NativeGitRepository[];
  const identities = [
    reader("reader-a", "reader-a-secret-1", "project-a"),
    reader("reader-b", "reader-b-secret-1", "project-b"),
    writer("writer-a", "writer-a-secret-1", "project-a", "workspace-a"),
    writer("writer-a-other", "writer-a-other-secret-1", "project-a", "workspace-other")
  ] as const satisfies readonly NativeGitIdentity[];
  const config = {
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 0,
    storageRoot,
    gitExecutable,
    gitVersion,
    repositories,
    identities
  } as const satisfies NativeGitServiceConfig;

  for (const repository of repositories) {
    const bare = await initializeNativeRepository(config, repository);
    await seedRepository(root, bare, `${repository.projectId}-initial`);
  }
  const service = createNativeGitServer(config);
  const baseUrl = await service.listen();
  return {
    root,
    baseUrl,
    config,
    repositoryPath: (projectId, repositoryId) => join(storageRoot, projectId, `${repositoryId}.git`),
    url: (username, password, projectId, repositoryId) =>
      `${baseUrl.replace("http://", `http://${username}:${password}@`)}/v1/projects/${projectId}/repositories/${repositoryId}.git`,
    git: async (cwd, args) => run(gitExecutable, [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
    }),
    close: async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function refValue(repository: string, ref: string): Promise<string | undefined> {
  try {
    return (await run(gitExecutable, ["--git-dir", repository, "rev-parse", "--verify", ref], {
      env: { ...process.env, LC_ALL: "C" }
    })).stdout.trim();
  } catch (error) {
    if (isExitError(error)) return undefined;
    throw error;
  }
}

export function isExitError(error: unknown): error is Error & { readonly stderr: string } {
  return error instanceof Error && "stderr" in error && typeof error.stderr === "string";
}

async function seedRepository(root: string, bare: string, content: string): Promise<void> {
  const source = join(root, `${content}-source`);
  await run(gitExecutable, ["init", "--initial-branch=main", source]);
  await run(gitExecutable, ["-C", source, "config", "user.name", "DIM test"]);
  await run(gitExecutable, ["-C", source, "config", "user.email", "dim-test@example.invalid"]);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(source, "README.md"), `${content}\n`));
  await run(gitExecutable, ["-C", source, "add", "README.md"]);
  await run(gitExecutable, ["-C", source, "commit", "-m", "initial"]);
  await run(gitExecutable, ["--git-dir", bare, "fetch", source, "refs/heads/main:refs/heads/main"]);
  await run(gitExecutable, ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
}

function reader(username: string, password: string, projectId: string): NativeGitIdentity {
  return { username, password, projectId, repositoryIds: ["source"], role: "reader" };
}

function writer(username: string, password: string, projectId: string, workspaceId: string): NativeGitIdentity {
  return { username, password, projectId, repositoryIds: ["source"], role: "writer", workspaceId };
}
