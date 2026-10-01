import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminBuiltinCall } from "../../../../core/packages/core/src/adminBuiltin.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { registerPlugins } from "../../../../core/packages/core/src/plugin.js";
import type { RepositorySet } from "../../../../core/packages/core/src/repositorySet.js";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";
import type { CommandResult, CommandRunner, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({
    kind: "managed" as const,
    adminUsername: "admin", adminPassword: "admin-secret",
    writerUsername: "writer", writerPassword: "writer-secret",
    maintainerUsername: "maintainer", maintainerPassword: "maintainer-secret",
    apiBaseUrl: "http://127.0.0.1:3300/api/v1",
    hostBaseUrl: "http://127.0.0.1:3300",
    workspaceBaseUrl: "http://dim-gitea:3000",
    runnerBaseUrl: "http://dim-gitea:3000"
  }))
}));

describe("project root origin rebind Git verification", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("accepts a descendant external tip without moving the managed branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-origin-rebind-git-"));
    cleanup.push(root);
    const work = join(root, "work");
    const managed = join(root, "managed.git");
    const external = join(root, "external.git");
    const processRunner = new ProcessRunner();
    await git(processRunner, ["init", work]);
    await git(processRunner, ["-C", work, "config", "user.name", "DIM Test"]);
    await git(processRunner, ["-C", work, "config", "user.email", "dim@example.invalid"]);
    await writeFile(join(work, "README.md"), "old\n");
    await git(processRunner, ["-C", work, "add", "README.md"]);
    await git(processRunner, ["-C", work, "commit", "-m", "old"]);
    await git(processRunner, ["-C", work, "branch", "-M", "main"]);
    await git(processRunner, ["init", "--bare", managed]);
    await git(processRunner, ["init", "--bare", external]);
    await git(processRunner, ["-C", work, "push", managed, "main"]);
    await git(processRunner, ["-C", work, "push", external, "main"]);
    const oldTip = await output(processRunner, ["-C", work, "rev-parse", "HEAD"]);
    await writeFile(join(work, "README.md"), "new\n");
    await git(processRunner, ["-C", work, "commit", "-am", "new"]);
    await git(processRunner, ["-C", work, "push", external, "main"]);
    const newTip = await output(processRunner, ["-C", work, "rev-parse", "HEAD"]);

    const state = new LifecycleState(join(root, "state"));
    const now = "2026-09-28T00:00:00.000Z";
    await state.claimProject({
      schemaVersion: 4, id: "project-id", name: "acme", gitNamespace: "dim-acme",
      giteaOrganizationId: 41, phase: "ready", rootRepositoryAlias: "root",
      rootRef: "refs/heads/main", repositories: [{
        alias: "root", ref: "refs/heads/main", providerRepoId: "dim-acme/root", owner: "dim-acme",
        hostUrl: "https://managed.example/root.git", workspaceUrl: "https://managed.internal/root.git",
        phase: "ready", connections: [{ name: "origin", url: "https://gitlab.example/acme/root.git" }],
        protectedPatterns: ["main"], forcePushBlockedPatterns: [], protectionPhase: "applied",
        createdAt: now, updatedAt: now
      }], createdAt: now, updatedAt: now
    });
    await state.writeHostLifecycle({
      schemaVersion: 2, phase: "ready", resumeWorkspaces: [], restartCiRunners: [],
      resumeManagedContainers: [], updatedAt: now
    });
    const runner = new UrlMappingRunner(processRunner, new Map([
      ["https://managed.example/root.git", managed],
      ["https://github.com/acme/root.git", external]
    ]));

    await adminBuiltinCall("repo.rebind-origin", {
      input: {
        project: "acme", alias: "root", approved: true,
        expectedOldOriginDigest: createHash("sha256").update("https://gitlab.example/acme/root.git").digest("hex"),
        expectedOriginTip: newTip,
        repositorySet: candidateSet()
      },
      lifecycle: { stateRoot: join(root, "state") } as LifecycleOptions,
      runner,
      plugins: await registerPlugins([])
    });

    expect(await output(processRunner, ["--git-dir", managed, "rev-parse", "refs/heads/main"])).toBe(oldTip);
    expect((await state.readProject("acme")).repositories[0]?.connections[0]?.url)
      .toBe("https://github.com/acme/root.git");
  });
});

function candidateSet(): RepositorySet {
  return {
    schemaVersion: 1, upstreams: {}, repositories: {
      root: {
        url: "https://github.com/acme/root.git", fallback: false, root: true, ref: "refs/heads/main",
        protectedPatterns: ["main"], forcePushBlockedPatterns: [], importBranches: {}, publishBranches: {}
      }
    }
  };
}

class UrlMappingRunner implements StreamingCommandRunner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly urls: ReadonlyMap<string, string>
  ) {}

  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    return this.runner.run(command, args.map((argument) => this.urls.get(argument) ?? argument), options);
  }

  async runStreaming(command: string, args: string[], options?: RunOptions): Promise<number> {
    return (await this.run(command, args, options)).exitCode;
  }
}

async function git(runner: CommandRunner, args: string[]): Promise<void> {
  const result = await runner.run("git", args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function output(runner: CommandRunner, args: string[]): Promise<string> {
  const result = await runner.run("git", args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
