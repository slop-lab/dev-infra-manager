import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type {
  GiteaCredentials,
  LifecycleOptions,
  ProjectRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  prepareQemuProjectHook,
  QEMU_CI_NO_HOOK_DIGEST
} from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import { QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const SOURCE_COMMIT = "a".repeat(40);
const MOVED_COMMIT = "b".repeat(40);
const credentials: GiteaCredentials = {
  adminUsername: "admin",
  adminPassword: "secret",
  writerUsername: "writer",
  writerPassword: "secret",
  maintainerUsername: "maintainer",
  maintainerPassword: "secret"
};

class HookRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly hook: Buffer | undefined,
    private readonly symbolicHead = false
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args.includes("ls-remote")) {
      return result(command, args, this.symbolicHead
        ? `ref: refs/heads/main\tHEAD\n${SOURCE_COMMIT}\tHEAD\n`
        : `${SOURCE_COMMIT}\trefs/heads/main\n`);
    }
    if (args[0] === "clone") {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing clone destination");
      await mkdir(join(destination, ".git"), { recursive: true });
      if (this.hook !== undefined) {
        await mkdir(join(destination, ".dim", "ci"), { recursive: true });
        await writeFile(join(destination, ".dim", "ci", "qemu-cache.bash"), this.hook);
      }
    }
    return result(command, args);
  }

  async runStreaming(): Promise<number> { return 0; }
}

describe("QEMU CI protected Project hook admission", () => {
  let stateRoot = "";
  let options: LifecycleOptions;
  let project: ProjectRecord;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-qemu-ci-hook-"));
    options = { stateRoot } as LifecycleOptions;
    project = projectFixture();
    await new LifecycleState(stateRoot).claimProject(project);
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("rejects a root whose provider protection is not applied", async () => {
    // Given
    const repository = rootRepository(project);
    project = { ...project, repositories: [{ ...repository, protectionPhase: "pending" }] };

    // When
    const preparation = prepare(new HookRunner(Buffer.from("echo cache\n")));

    // Then
    await expect(preparation).rejects.toThrow(/protection is not applied/);
  });

  it("rejects a resolved branch outside the applied protected patterns", async () => {
    // Given
    const repository = rootRepository(project);
    project = { ...project, repositories: [{ ...repository, protectedPatterns: ["release/*"] }] };

    // When
    const preparation = prepare(new HookRunner(Buffer.from("echo cache\n")));

    // Then
    await expect(preparation).rejects.toThrow(/is not covered by protected patterns/);
  });

  it("resolves symbolic HEAD once to concrete hook provenance", async () => {
    // Given
    const headProject = { ...project };
    delete headProject.rootRef;
    project = headProject;

    // When
    const prepared = await prepare(new HookRunner(Buffer.from("echo cache\n"), true));

    // Then
    expect(prepared).toMatchObject({ sourceRef: "refs/heads/main", sourceCommit: SOURCE_COMMIT, kind: "present" });
  });

  it("stages exact blob bytes from the selected commit even after its branch moves", async () => {
    // Given
    const exactBytes = Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0d, 0x0a, 0xff, 0x0a]);
    const runner = new HookRunner(exactBytes);

    // When
    const prepared = await prepare(runner);

    // Then
    expect(prepared.digest).toBe(createHash("sha256").update(exactBytes).digest("hex"));
    expect(await readFile(prepared.path)).toEqual(exactBytes);
    expect(runner.calls.some((call) => call.includes(SOURCE_COMMIT))).toBe(true);
    expect(runner.calls.some((call) => call.includes(MOVED_COMMIT))).toBe(false);
    expect(runner.calls.some((call) => call.includes(`${project.rootRef}:.dim/ci/qemu-cache.bash`))).toBe(false);
  });

  it("publishes absent hooks as deterministic immutable executable bytes", async () => {
    // Given
    const expectedBytes = Buffer.from(QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT);
    const emptyDigest = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

    // When
    const prepared = await prepare(new HookRunner(undefined));

    // Then
    expect(prepared).toMatchObject({
      sourceRef: "refs/heads/main",
      sourceCommit: SOURCE_COMMIT,
      kind: "absent",
      digest: createHash("sha256").update(expectedBytes).digest("hex")
    });
    expect(prepared.digest).toBe(QEMU_CI_NO_HOOK_DIGEST);
    expect(prepared.digest).not.toBe(emptyDigest);
    expect(await readFile(prepared.path)).toEqual(expectedBytes);
    expect((await stat(prepared.path)).mode & 0o777).toBe(0o500);
    expect(JSON.parse(await readFile(join(dirname(prepared.path), "provenance.json"), "utf8"))).toEqual({
      sourceRef: prepared.sourceRef,
      sourceCommit: prepared.sourceCommit,
      kind: prepared.kind,
      digest: prepared.digest
    });
  });

  it("reuses matching immutable bytes while separating changed commits and Projects", async () => {
    // Given
    const hook = Buffer.from("echo cache\n");
    const first = await prepare(new HookRunner(hook));
    project = { ...project, id: "other-id", name: "other" };

    // When
    const otherProject = await prepare(new HookRunner(hook));

    // Then
    expect(await prepare(new HookRunner(hook))).toEqual(otherProject);
    expect(otherProject.path).not.toBe(first.path);
  });

  it("fails closed for mismatched pre-existing hook bytes", async () => {
    // Given
    const hook = Buffer.from("echo cache\n");
    const digest = createHash("sha256").update(hook).digest("hex");
    const directory = join(stateRoot, "assets", "qemu-ci-projects", project.id, "hooks", SOURCE_COMMIT, `present-${digest}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "cache.bash"), "mismatched bytes\n");

    // When
    const preparation = prepare(new HookRunner(hook));

    // Then
    await expect(preparation).rejects.toThrow(/mismatched.*hook bytes/i);
  });

  function prepare(runner: StreamingCommandRunner) {
    return prepareQemuProjectHook({ runner, options, project, credentials });
  }
});

function projectFixture(): ProjectRecord {
  return {
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
}

function rootRepository(project: ProjectRecord): ProjectRecord["repositories"][number] {
  const repository = project.repositories[0];
  if (repository === undefined) throw new Error("missing root repository fixture");
  return repository;
}

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}
