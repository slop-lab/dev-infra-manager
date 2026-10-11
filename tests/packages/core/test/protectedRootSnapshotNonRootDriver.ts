import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { GiteaCredentials, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { resolveProtectedRootSnapshot } from "../../../../core/packages/core/src/protectedRootSnapshot.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const SUCCESS_COMMIT = "a".repeat(40);
const FAILURE_COMMIT = "b".repeat(40);
const EXPECTED_UID = 1000;
const credentials: GiteaCredentials = {
  adminUsername: "admin",
  adminPassword: "secret",
  writerUsername: "writer",
  writerPassword: "secret",
  maintainerUsername: "maintainer",
  maintainerPassword: "secret"
};

class NonRootSnapshotRunner implements StreamingCommandRunner {
  cloneCount = 0;

  constructor(
    private readonly commit: string,
    private readonly collisionTarget?: string
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args.includes("ls-remote")) return result(command, args, `${this.commit}\trefs/heads/main\n`);
    if (args[0] === "clone") {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing clone destination");
      this.cloneCount += 1;
      await mkdir(join(destination, ".git"), { recursive: true });
      await mkdir(join(destination, "ops"), { recursive: true });
      await writeFile(join(destination, "ops", "config.txt"), "approved\n");
    }
    if (args.includes("checkout") && this.collisionTarget !== undefined) {
      await mkdir(this.collisionTarget, { recursive: true });
      await writeFile(join(this.collisionTarget, "occupied"), "collision\n");
    }
    return result(command, args);
  }

  async runStreaming(): Promise<number> { return 0; }
}

const stateRoot = process.argv[2];
if (stateRoot === undefined) throw new Error("state root is required");
if (process.getuid?.() !== EXPECTED_UID) throw new Error(`driver must run as uid ${EXPECTED_UID}`);

const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot });
const state = new LifecycleState(stateRoot);
const successfulProject = project("successful-project", "successful-project-id");
await state.claimProject(successfulProject);
const successfulRunner = new NonRootSnapshotRunner(SUCCESS_COMMIT);
const created = await resolveProtectedRootSnapshot({
  runner: successfulRunner,
  options,
  projectName: successfulProject.name,
  credentials
});
const publishedRoot = await stat(created.rootSnapshotPath);
if (publishedRoot.uid !== EXPECTED_UID) throw new Error("snapshot owner changed");
if ((publishedRoot.mode & 0o222) !== 0 || ((await stat(join(created.rootSnapshotPath, "ops"))).mode & 0o222) !== 0) {
  throw new Error("published directories are writable");
}
try {
  await writeFile(join(created.rootSnapshotPath, "ops", "config.txt"), "modified\n");
  throw new Error("published file was writable");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EACCES")) throw error;
}
process.stdout.write("created\n");

const reused = await resolveProtectedRootSnapshot({
  runner: successfulRunner,
  options,
  projectName: successfulProject.name,
  credentials
});
if (reused.rootSnapshotPath !== created.rootSnapshotPath || successfulRunner.cloneCount !== 1) {
  throw new Error("snapshot was not reused");
}
process.stdout.write("reused\n");

const failingProject = project("failing-project", "failing-project-id");
await state.claimProject(failingProject);
const projectRoot = join(stateRoot, "assets", "project-roots", failingProject.id);
const collisionTarget = join(projectRoot, FAILURE_COMMIT);
try {
  await resolveProtectedRootSnapshot({
    runner: new NonRootSnapshotRunner(FAILURE_COMMIT, collisionTarget),
    options,
    projectName: failingProject.name,
    credentials
  });
  throw new Error("publication collision unexpectedly succeeded");
} catch (error) {
  if (!(error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY"))) throw error;
}
process.stdout.write("original-error-preserved\n");

const entries = await readdir(projectRoot);
if (entries.some((entry) => entry.startsWith(".staging-"))) throw new Error("failed staging directory remains");
process.stdout.write("failed-staging-cleaned\n");

function project(name: string, id: string): ProjectRecord {
  return {
    schemaVersion: 4,
    id,
    name,
    gitNamespace: name,
    giteaOrganizationId: 41,
    phase: "ready",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    repositories: [{
      alias: "root",
      providerRepoId: `${name}/root`,
      owner: name,
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
}

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}
