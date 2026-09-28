import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminBuiltinCall } from "../../../../core/packages/core/src/adminBuiltin.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type {
  LifecycleOptions,
  ProjectRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import { registerPlugins } from "../../../../core/packages/core/src/plugin.js";
import {
  planProjectRepositorySet,
  rebindProjectRootOrigin
} from "../../../../core/packages/core/src/projectRegistry.js";
import type { RepositorySet } from "../../../../core/packages/core/src/repositorySet.js";
import type { CommandResult, CommandRunner, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

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

const OLD_TIP = "1".repeat(40);
const NEW_TIP = "2".repeat(40);
const CHANGED_TIP = "3".repeat(40);
const OLD_ORIGIN = "https://gitlab.example/acme/root.git";
const NEW_ORIGIN = "https://github.com/acme/root.git";
const OLD_ORIGIN_DIGEST = createHash("sha256").update(OLD_ORIGIN).digest("hex");

describe("project root origin rebind", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("keeps an ordinary origin change as a conflict", async () => {
    const { options } = await readyProject(cleanup);

    const plan = await planProjectRepositorySet(options, "acme", candidateSet(), false);

    expect(plan.actions).toMatchObject([{ alias: "root", action: "conflict" }]);
  });

  it("plans only an explicitly selected matching root origin as a rebind", async () => {
    const { options } = await readyProject(cleanup);

    const plan = await planProjectRepositorySet(options, "acme", candidateSet(), false, {
      rebindOrigin: "root"
    });

    expect(plan.actions).toMatchObject([{ alias: "root", action: "rebind" }]);
    expect(plan.actions[0]?.expectedOriginDigest).toBe(OLD_ORIGIN_DIGEST);
    expect(plan.preservedAliases).toEqual(["legacy"]);
    expect(JSON.stringify(plan)).not.toContain(OLD_ORIGIN);
  });

  it("refuses an admin request without explicit approval and preserves state", async () => {
    const { state, options } = await readyProject(cleanup, true);
    const before = await state.readProject("acme");

    await expect(adminBuiltinCall("repo.rebind-origin", {
      input: {
        project: "acme",
        alias: "root",
        expectedOldOriginDigest: OLD_ORIGIN_DIGEST,
        expectedOriginTip: NEW_TIP,
        repositorySet: candidateSet()
      },
      lifecycle: options,
      runner: new ScriptedRunner([]),
      plugins: await registerPlugins([])
    })).rejects.toThrow(/approval/);

    expect(await state.readProject("acme")).toEqual(before);
  });

  it.each(["2".repeat(39), "A".repeat(40)])("refuses invalid expected tip %s before Git access", async (tip) => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = new ScriptedRunner([]);

    await expect(rebindProjectRootOrigin(runner, options, rebindInput(tip))).rejects.toThrow(/40 lowercase/);

    expect(runner.calls).toEqual([]);
    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses unsafe origin transport without exposing URL credentials", async () => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const unsafe = candidateSet("https://operator:top-secret@github.com/acme/root.git");

    const failure = rebindProjectRootOrigin(new ScriptedRunner([]), options, {
      ...rebindInput(NEW_TIP),
      repositorySet: unsafe
    });

    await expect(failure).rejects.toThrow(/credentials/);
    await expect(failure).rejects.not.toThrow(/top-secret/);
    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses a changed external tip and preserves state", async () => {
    const { state, options } = await readyProject(cleanup, true);
    const before = await state.readProject("acme");
    const runner = gitRunner([OLD_TIP, CHANGED_TIP]);

    await expect(adminBuiltinCall("repo.rebind-origin", {
      input: rebindInput(NEW_TIP),
      lifecycle: options,
      runner,
      plugins: await registerPlugins([])
    })).rejects.toThrow(/expected origin tip/);

    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses an advertised branch other than the selected root ref", async () => {
    // Given
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = new ScriptedRunner([{ stdout: `${OLD_TIP}\trefs/heads/other\n` }]);

    // When / Then
    await expect(rebindProjectRootOrigin(runner, options, rebindInput(NEW_TIP)))
      .rejects.toThrow(/managed root returned an invalid Git branch tip/);
    expect(runner.calls).toHaveLength(1);
    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses a recorded origin changed after planning and preserves state", async () => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = new ScriptedRunner([]);

    await expect(rebindProjectRootOrigin(runner, options, {
      ...rebindInput(NEW_TIP),
      expectedOldOriginDigest: "0".repeat(64)
    })).rejects.toThrow(/changed after the reviewed rebind plan/);

    expect(runner.calls).toEqual([]);
    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses unrelated history and preserves state", async () => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = gitRunner([OLD_TIP, NEW_TIP, undefined, undefined, undefined], 1);

    await expect(rebindProjectRootOrigin(runner, options, rebindInput(NEW_TIP))).rejects.toThrow(/not an ancestor/);

    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses a managed tip changed during verification and preserves state", async () => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = gitRunner([OLD_TIP, NEW_TIP, undefined, undefined, undefined, CHANGED_TIP]);

    await expect(rebindProjectRootOrigin(runner, options, rebindInput(NEW_TIP))).rejects.toThrow(/managed root changed/);

    expect(await state.readProject("acme")).toEqual(before);
  });

  it("refuses an external tip changed during verification and preserves state", async () => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = gitRunner([
      OLD_TIP, NEW_TIP, undefined, undefined, undefined, OLD_TIP, CHANGED_TIP
    ]);

    await expect(rebindProjectRootOrigin(runner, options, rebindInput(NEW_TIP))).rejects.toThrow(/requested origin changed/);

    expect(await state.readProject("acme")).toEqual(before);
  });

  it("changes only the ready root origin after exact-tip ancestry and CAS checks", async () => {
    const { state, options } = await readyProject(cleanup);
    const before = await state.readProject("acme");
    const runner = gitRunner([
      OLD_TIP, NEW_TIP, undefined, undefined, undefined, OLD_TIP, NEW_TIP
    ]);

    const repository = await rebindProjectRootOrigin(runner, options, rebindInput(NEW_TIP));

    const after = await state.readProject("acme");
    expect(repository.connections[0]?.url).toBe(NEW_ORIGIN);
    expect(after.repositories).toHaveLength(2);
    expect(after.repositories[1]).toEqual(before.repositories[1]);
    expect(after.rootRepositoryAlias).toBe(before.rootRepositoryAlias);
    expect(after.rootRef).toBe(before.rootRef);
    expect(after.repositories[0]).toEqual({
      ...before.repositories[0],
      connections: [{ name: "origin", url: NEW_ORIGIN }],
      updatedAt: after.repositories[0]?.updatedAt
    });
  });
});

function rebindInput(expectedOriginTip: string) {
  return {
    project: "acme",
    alias: "root",
    expectedOldOriginDigest: OLD_ORIGIN_DIGEST,
    expectedOriginTip,
    approved: true,
    repositorySet: candidateSet()
  };
}

function candidateSet(url = NEW_ORIGIN): RepositorySet {
  return {
    schemaVersion: 1,
    upstreams: {},
    repositories: {
      root: {
        url, fallback: false, root: true, ref: "refs/heads/main",
        protectedPatterns: ["main"], forcePushBlockedPatterns: [],
        importBranches: {}, publishBranches: {}
      }
    }
  };
}

async function readyProject(cleanup: string[], hostReady = false): Promise<{
  readonly state: LifecycleState;
  readonly options: LifecycleOptions;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "dim-origin-rebind-"));
  cleanup.push(stateRoot);
  const state = new LifecycleState(stateRoot);
  const now = "2026-09-28T00:00:00.000Z";
  const repositories: ProjectRecord["repositories"] = [{
    alias: "root", ref: "refs/heads/main", providerRepoId: "dim-acme/root", owner: "dim-acme",
    hostUrl: "https://managed.example/dim-acme/root.git", workspaceUrl: "https://managed.internal/dim-acme/root.git",
    phase: "ready", connections: [{ name: "origin", url: OLD_ORIGIN }],
    protectedPatterns: ["main"], forcePushBlockedPatterns: [], protectionPhase: "applied",
    createdAt: now, updatedAt: now
  }, {
    alias: "legacy", providerRepoId: "dim-acme/legacy", owner: "dim-acme",
    hostUrl: "https://managed.example/dim-acme/legacy.git", workspaceUrl: "https://managed.internal/dim-acme/legacy.git",
    phase: "ready", connections: [{ name: "origin", url: "https://gitlab.example/acme/legacy.git" }],
    protectedPatterns: [], forcePushBlockedPatterns: [], protectionPhase: "applied",
    createdAt: now, updatedAt: now
  }];
  await state.claimProject({
    schemaVersion: 4, id: "project-id", name: "acme", gitNamespace: "dim-acme",
    giteaOrganizationId: 41, phase: "ready", rootRepositoryAlias: "root",
    rootRef: "refs/heads/main", repositories, createdAt: now, updatedAt: now
  });
  if (hostReady) {
    await state.writeHostLifecycle({
      schemaVersion: 2, phase: "ready", resumeWorkspaces: [], restartCiRunners: [],
      resumeManagedContainers: [], updatedAt: now
    });
  }
  return { state, options: { stateRoot } as LifecycleOptions };
}

function gitRunner(outputs: Array<string | undefined>, mergeBaseExitCode = 0): ScriptedRunner {
  return new ScriptedRunner(outputs.map((output, index) => ({
    stdout: output === undefined ? "" : `${output}\trefs/heads/main\n`,
    exitCode: index === 4 ? mergeBaseExitCode : 0
  })));
}

class ScriptedRunner implements StreamingCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];

  constructor(private readonly results: ReadonlyArray<Partial<CommandResult>>) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const result = this.results[this.calls.length - 1] ?? {};
    return { command, args, stdout: "", stderr: "", exitCode: 0, ...result };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}
