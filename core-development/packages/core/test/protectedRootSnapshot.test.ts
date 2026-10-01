import { spawn } from "node:child_process";
import { chown, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { createWorkspace } from "../../../../core/packages/core/src/workspaceCreation.js";
import {
  protectedRootSnapshotPath,
  removeProtectedRootSnapshots,
  resolveProtectedRootSnapshot,
  type ProtectedRootSnapshot
} from "../../../../core/packages/core/src/protectedRootSnapshot.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const COMMIT = "a".repeat(40);
const NON_ROOT_UID = 1000;
const nonRootDriver = fileURLToPath(new URL("./protectedRootSnapshotNonRootDriver.ts", import.meta.url));

class SnapshotRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  constructor(
    private readonly lifecycleFile: "regular" | "symlink" = "regular",
    private readonly symbolicHead = false
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args.includes("ls-remote")) {
      return {
        command,
        args,
        stdout: this.symbolicHead
          ? `ref: refs/heads/main\tHEAD\n${COMMIT}\tHEAD\n`
          : `${COMMIT}\trefs/heads/main\n`,
        stderr: "",
        exitCode: 0
      };
    }
    if (args[0] === "clone") {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing clone destination");
      await mkdir(join(destination, ".git"), { recursive: true });
      await mkdir(join(destination, ".dim"), { recursive: true });
      if (this.lifecycleFile === "symlink") {
        await symlink("../../mutable-setup.sh", join(destination, ".dim", "setup.sh"));
      } else {
        await writeFile(join(destination, ".dim", "setup.sh"), "approved\n");
      }
      await writeFile(join(destination, "complete-tree.txt"), "included\n");
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> { return 0; }
}

describe("protected Project root snapshots", () => {
  let root = "";
  let options: LifecycleOptions;
  let project: ProjectRecord;

  it("derives the protected-root path solely from state, Project identity, and commit", () => {
    // Given / When
    const snapshotPath = protectedRootSnapshotPath("/state", "project-id", COMMIT);

    // Then
    expect(snapshotPath).toBe(join("/state", "assets", "project-roots", "project-id", COMMIT));
  });

  it.each([
    ["invalid Project identity", "../project", COMMIT, /project ID/],
    ["invalid root commit", "project-id", "../commit", /root commit/]
  ] as const)("rejects %s before deriving a protected-root path", (_case, projectId, commit, expected) => {
    // Given / When / Then
    expect(() => protectedRootSnapshotPath("/state", projectId, commit)).toThrow(expected);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-protected-root-"));
    options = { stateRoot: root } as LifecycleOptions;
    project = {
    schemaVersion: 4,
      id: "project-id",
      name: "project",
    gitNamespace: "dim-project",
    giteaOrganizationId: 41,
      phase: "ready",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [{
        alias: "root",
        providerRepoId: "dim-project/root",
        owner: "dim-project",
        hostUrl: "http://host/root.git",
        workspaceUrl: "http://workspace/root.git",
        phase: "ready",
        connections: [],
        protectedPatterns: ["main"],
        protectionPhase: "applied",
        createdAt: "now",
        updatedAt: "now"
      }],
      createdAt: "now",
      updatedAt: "now"
    };
    await new LifecycleState(root).claimProject(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("publishes the complete selected commit outside the mutable checkout", async () => {
    // Given
    const runner = new SnapshotRunner();

    // When
    const snapshot = await resolve(runner);

    // Then
    expect(snapshot).toMatchObject({ rootRef: "refs/heads/main", rootCommit: COMMIT });
    expect(await readFile(join(snapshot.rootSnapshotPath, ".dim", "setup.sh"), "utf8")).toBe("approved\n");
    expect(await readFile(join(snapshot.rootSnapshotPath, "complete-tree.txt"), "utf8")).toBe("included\n");
    expect(snapshot.rootSnapshotPath.startsWith(join(root, "assets", "project-roots"))).toBe(true);
    expect((await stat(join(snapshot.rootSnapshotPath, ".dim", "setup.sh"))).mode & 0o222).toBe(0);
  });

  it("checks out the commit selected before a protected branch can move", async () => {
    // Given
    const runner = new SnapshotRunner();

    // When
    await resolve(runner);

    // Then
    expect(runner.calls.some((call) => call.includes(COMMIT))).toBe(true);
    expect(runner.calls.some((call) => call.includes("refs/heads/main") && call[1] === "clone")).toBe(false);
  });

  it("preserves symbolic HEAD separately from its concrete protected branch", async () => {
    // Given
    const headProject = { ...project };
    delete headProject.rootRef;
    await new LifecycleState(root).writeProject(headProject);

    // When
    const snapshot = await resolve(new SnapshotRunner("regular", true));

    // Then
    expect(snapshot).toMatchObject({
      rootRequestedRef: "HEAD",
      rootRef: "refs/heads/main",
      rootCommit: COMMIT
    });
  });

  it.each(["creating", "importing", "error"] as const)(
    "rejects a %s repository before remote lookup or workspace claim",
    async (phase) => {
      // Given
      const stateRoot = root;
      const repository = project.repositories[0];
      if (repository === undefined) throw new Error("missing root repository fixture");
      await new LifecycleState(stateRoot).writeProject({
        ...project,
        repositories: [repository, {
          ...repository,
          alias: "pending",
          providerRepoId: "dim-project/pending",
          hostUrl: "http://host/pending.git",
          workspaceUrl: "http://workspace/pending.git",
          phase
        }]
      });
      const runner = new SnapshotRunner();

      // When / Then
      await expect(createWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot }), {
        project: project.name,
        name: "work-1",
        profiles: [],
        runtimeBackend: "sysbox"
      })).rejects.toThrow(new RegExp(`repository 'pending' is not ready \\(phase: ${phase}\\)`));
      expect(runner.calls).toHaveLength(0);
      await expect(new LifecycleState(stateRoot).readWorkspace("work-1")).rejects.toThrow(/not found/);
    }
  );

  it("rejects a root whose branch protection is not applied", async () => {
    // Given
    const state = new LifecycleState(root);
    const repository = project.repositories[0];
    if (repository === undefined) throw new Error("missing root repository fixture");

    // When / Then
    await state.writeProject({ ...project, repositories: [{ ...repository, protectionPhase: "pending" }] });
    await expect(resolve(new SnapshotRunner())).rejects.toThrow(/protection is not applied/);
  });

  it("rejects a selected branch not covered by protected patterns", async () => {
    // Given
    const state = new LifecycleState(root);
    const repository = project.repositories[0];
    if (repository === undefined) throw new Error("missing root repository fixture");

    // When / Then
    await state.writeProject({ ...project, repositories: [{ ...repository, protectedPatterns: ["release/*"] }] });
    await expect(resolve(new SnapshotRunner())).rejects.toThrow(/is not covered by protected patterns/);
  });

  it("rejects a non-ready root repository", async () => {
    // Given
    const state = new LifecycleState(root);
    const repository = project.repositories[0];
    if (repository === undefined) throw new Error("missing root repository fixture");
    await state.writeProject({ ...project, repositories: [{ ...repository, phase: "error" }] });

    // When / Then
    await expect(resolve(new SnapshotRunner())).rejects.toThrow(/root repo 'root' is not ready/);
  });

  it("rejects a root ref that is not a concrete branch", async () => {
    // Given
    await new LifecycleState(root).writeProject({ ...project, rootRef: "refs/tags/release" });

    // When / Then
    await expect(resolve(new SnapshotRunner())).rejects.toThrow(/does not resolve to a concrete branch/);
  });

  it("rejects a symlinked reserved lifecycle file", async () => {
    // Given
    const runner = new SnapshotRunner("symlink");

    // When / Then
    await expect(resolve(runner)).rejects.toThrow(/reserved lifecycle path.*symbolic link/);
  });

  it("retains read-only snapshots until explicit Project removal", async () => {
    // Given
    const snapshot = await resolve(new SnapshotRunner());

    // When
    await removeProtectedRootSnapshots(root, project.id);

    // Then
    await expect(stat(snapshot.rootSnapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.getuid?.() === 0 || process.getuid?.() === NON_ROOT_UID)(
    "creates, reuses, and cleans failed unpublished snapshots as uid 1000",
    async () => {
      // Given
      const driverRoot = await mkdtemp(join(tmpdir(), "dim-protected-root-nonroot-"));
      if (process.getuid?.() === 0) await chown(driverRoot, NON_ROOT_UID, NON_ROOT_UID);

      try {
        // When
        const result = await runNonRootDriver(driverRoot);

        // Then
        expect(result).toEqual({
          code: 0,
          stdout: "created\nreused\noriginal-error-preserved\nfailed-staging-cleaned\n",
          stderr: ""
        });
      } finally {
        await rm(driverRoot, { recursive: true, force: true });
      }
    }
  );

  function resolve(runner: StreamingCommandRunner): Promise<ProtectedRootSnapshot> {
    return resolveProtectedRootSnapshot({
      runner,
      options,
      projectName: project.name,
      credentials: {
        adminUsername: "admin",
        adminPassword: "secret",
        writerUsername: "writer",
        writerPassword: "secret",
        maintainerUsername: "maintainer",
        maintainerPassword: "secret"
      }
    });
  }
});

function runNonRootDriver(root: string): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const dropPrivileges = process.getuid?.() === 0;
    const child = spawn(process.execPath, ["--import", "tsx", nonRootDriver, root], {
      ...(dropPrivileges ? { uid: NON_ROOT_UID, gid: NON_ROOT_UID } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
