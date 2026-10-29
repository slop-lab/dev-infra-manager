import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type GitFixture = {
  readonly root: string;
  readonly repository: string;
  readonly selectedCommit: string;
  readonly priorCommit: string;
  readonly unrelatedCommit: string;
};

const gitEnvironment = {
  ...process.env,
  GIT_MASTER: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
} satisfies NodeJS.ProcessEnv;

export async function git(repository: string, arguments_: readonly string[]): Promise<string> {
  const result = await execute("git", ["--no-replace-objects", "-C", repository, ...arguments_], {
    env: gitEnvironment,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function commitAll(repository: string, message: string): Promise<string> {
  await git(repository, ["add", "--all"]);
  await git(repository, ["-c", "user.name=Export Test", "-c", "user.email=export@example.invalid", "commit", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

export async function createGitFixture(objectFormat: "sha1" | "sha256" = "sha1"): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "gs-export-test-"));
  const repository = join(root, "repository");
  await mkdir(repository, { mode: 0o700 });
  await git(repository, ["init", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await mkdir(join(repository, "packages/gs/lib"), { recursive: true });
  await writeFile(join(repository, "packages/gs/package.json"), JSON.stringify({
    name: "@this-project/gs-workspace",
    private: true,
    packageManager: "pnpm@10.13.1",
  }));
  await writeFile(join(repository, "packages/gs/lib/package.json"), JSON.stringify({
    name: "@slop-lab/gs-lib",
    private: true,
    dependencies: { zod: "4.6.6" },
  }));
  await writeFile(join(repository, "packages/gs/lib/old.txt"), "prior content\n");
  await writeFile(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const priorCommit = await commitAll(repository, "initial GS source");

  await mkdir(join(repository, "packages/gs/app/bin"), { recursive: true });
  await writeFile(join(repository, "packages/gs/app/package.json"), JSON.stringify({
    name: "@slop-lab/gs-app",
    private: true,
    dependencies: { "@slop-lab/gs-lib": "workspace:1.0.0" },
  }));
  await rename(join(repository, "packages/gs/lib/old.txt"), join(repository, "packages/gs/lib/current.txt"));
  await writeFile(join(repository, "packages/gs/app/bin/run.sh"), "#!/bin/sh\nprintf 'héllo\\n'\n");
  await chmod(join(repository, "packages/gs/app/bin/run.sh"), 0o755);
  await symlink("../lib/current.txt", join(repository, "packages/gs/app/current"));
  await symlink("lib/current.txt", join(repository, "packages/gs/latest"));
  await symlink("dist/generated.js", join(repository, "packages/gs/generated"));
  const selectedCommit = await commitAll(repository, "move GS source");

  await git(repository, ["switch", "--create", "unrelated"]);
  await writeFile(join(repository, "unrelated-secret.txt"), "not in selected history\n");
  const unrelatedCommit = await commitAll(repository, "unrelated branch");
  await git(repository, ["switch", "main"]);
  await writeFile(join(repository, "packages/gs/untracked.txt"), "not selected\n");
  return { root, repository, selectedCommit, priorCommit, unrelatedCommit };
}

export async function runExporter(
  repository: string,
  commit: string,
  output: string,
  ambientEnvironment: NodeJS.ProcessEnv = {},
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const tool = new URL("../../../scripts/packages/export-gs-source.ts", import.meta.url).pathname;
  try {
    const result = await execute(process.execPath, [tool, "--source", repository, "--commit", commit, "--output", output], {
      cwd: repository,
      env: { ...gitEnvironment, ...ambientEnvironment },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !("stdout" in error) || !("stderr" in error)) throw error;
    return {
      status: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}
