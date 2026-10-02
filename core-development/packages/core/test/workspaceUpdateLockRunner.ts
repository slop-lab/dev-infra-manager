import { vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { ownedGiteaContainerInspect, ownedGiteaResourceInspect } from "./giteaServiceFixture.js";
import { workspaceContainerInspect, workspaceVolumeInspect } from "./workspaceOwnershipFixture.js";

const WORKSPACE_IDENTITY = {
  name: "work-1",
  workspaceId: "A".repeat(43),
  projectId: "project-id",
  projectName: "project",
  rootRepositoryAlias: "root",
  runtimeBackend: "sysbox",
  containerName: "dim-ws-work-1",
  dockerVolumeName: "dim-ws-work-1-docker"
} as const;

export const COMMIT = "a".repeat(40);

export const INITIAL_COMMIT = "b".repeat(40);

export const SOURCE_COMMIT = "c".repeat(40);

export const MOVED_SOURCE_COMMIT = "d".repeat(40);

export const HEAD_COMMIT = "e".repeat(40);

export const MOVED_HEAD_COMMIT = "f".repeat(40);

export const CREDENTIALS = JSON.stringify({
  adminUsername: "admin",
  adminPassword: "admin-secret",
  writerUsername: "writer",
  writerPassword: "writer-secret",
  maintainerUsername: "maintainer",
  maintainerPassword: "maintainer-secret"
});

export class Barrier {
  readonly wait: Promise<void>;
  private openBarrier: () => void = () => undefined;

  constructor() {
    this.wait = new Promise((resolve) => { this.openBarrier = resolve; });
  }

  open(): void {
    this.openBarrier();
  }
}

export class UpdateRunner implements StreamingCommandRunner {
  readonly runCalls: string[][] = [];
  readonly streamingCalls: string[][] = [];
  readonly lifecycleEvents: string[] = [];
  readonly publishedManifests: Record<string, unknown>[] = [];
  manifestPublicationAttempts = 0;
  sourceCommit = SOURCE_COMMIT;
  headCommit = HEAD_COMMIT;
  containerRootSnapshotPath = "";
  containerExists = true;
  workspaceId = WORKSPACE_IDENTITY.workspaceId;

  constructor(
    private remainingManifestFailures = 0,
    private readonly projectSetupExitCode?: number
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runCalls.push([command, ...args]);
    if (command === "git" && args.includes("ls-remote")) {
      if (args.includes("http://host/source.git")) {
        return result(command, args, `${this.sourceCommit}\trefs/heads/development\n`);
      }
      if (args.includes("http://host/head.git")) {
        return result(command, args, `ref: refs/heads/trunk\tHEAD\n${this.headCommit}\tHEAD\n`);
      }
      return result(command, args, `${COMMIT}\trefs/heads/main\n`);
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const stdout = args.some((argument) => argument.includes("dim.service-id"))
        ? ownedGiteaResourceInspect("network")
        : "true";
      return result(command, args, `${stdout}\n`);
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const stdout = args[2] === WORKSPACE_IDENTITY.dockerVolumeName
        ? `${workspaceVolumeInspect(WORKSPACE_IDENTITY)}\n`
        : args[2] === "dim-gitea-data"
          ? `${ownedGiteaResourceInspect("volume")}\n`
          : "true\n";
      return result(command, args, stdout);
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-gitea") {
      return result(command, args, `${ownedGiteaContainerInspect("gitea-container-id", true)}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-registry-cache") {
      return result(command, args, "true|true|registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33\n");
    }
    if (args[0] === "exec" && args[1] === "gitea-container-id"
      && args.some((argument) => argument.includes("/data/dim/credentials.json"))) {
      return result(command, args, CREDENTIALS);
    }
    if (args[0] === "exec" && args[3] === "gitea-container-id" && args[4] === "sh") {
      return result(command, args, "true\n");
    }
    if (args.some((argument) => argument.includes(".Config.Labels"))) {
      if (!this.containerExists) {
        return { command, args, stdout: "", stderr: `Error: No such object: ${WORKSPACE_IDENTITY.containerName}`, exitCode: 1 };
      }
      return result(command, args, `${workspaceContainerInspect({ ...WORKSPACE_IDENTITY, workspaceId: this.workspaceId }, {
        rootSnapshotPath: this.containerRootSnapshotPath
      })}\n`);
    }
    if (args[0] === "container" && args[1] === "rm") {
      this.containerExists = false;
      this.lifecycleEvents.push("container-remove");
      return result(command, args);
    }
    if (args[0] === "run") {
      const workspaceIdLabel = args.find((argument) => argument.startsWith("dim.workspace-id="));
      this.workspaceId = workspaceIdLabel?.slice("dim.workspace-id=".length) ?? this.workspaceId;
      const rootMount = args.find((argument) => argument.includes("target=/run/dim/project-root"));
      this.containerRootSnapshotPath = rootMount?.match(/source=([^,]+)/)?.[1] ?? "missing";
      this.containerExists = true;
      this.lifecycleEvents.push("container-create");
      return result(command, args, "workspace-container-id\n");
    }
    if (args.includes("{{.State.Running}}")) return result(command, args, "true\n");
    if (args.includes("git") && args.includes("merge") && args.includes("--ff-only")) {
      this.lifecycleEvents.push("root-merge");
    }
    if (args.some((argument) => argument.startsWith("DIM_PROJECT_MANIFEST_B64="))) {
      this.lifecycleEvents.push("manifest-publication");
      this.manifestPublicationAttempts += 1;
      const encoded = args.find((argument) => argument.startsWith("DIM_PROJECT_MANIFEST_B64="))?.split("=", 2)[1];
      if (encoded !== undefined) {
        this.publishedManifests.push(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
      }
      if (this.remainingManifestFailures > 0) {
        this.remainingManifestFailures -= 1;
        return { command, args, stdout: "", stderr: "injected manifest failure", exitCode: 1 };
      }
    }
    if (args.at(-2) === "-f") {
      const exists = this.projectSetupExitCode !== undefined && args.at(-1) === ".dim/setup.sh";
      return result(command, args, "", exists ? 0 : 1);
    }
    return result(command, args);
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streamingCalls.push([command, ...args]);
    if (args.some((argument) => argument.endsWith("/.dim/setup.sh"))) {
      this.lifecycleEvents.push("project-setup");
      return this.projectSetupExitCode ?? 0;
    }
    return 0;
  }
}

export class LockInterleaving {
  readonly firstSetupAttempted = new Barrier();
  readonly allowFirstSetup = new Barrier();
  projectHeldAtFirstSetup = false;
  private projectLocks = 0;
  private setupAttempts = 0;

  install(): void {
    const interleaving = this;
    const acquireProjectLock = LifecycleState.prototype.acquireProjectLock;
    const acquireSetupLock = LifecycleState.prototype.acquireWorkspaceSetupLock;
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockImplementation(async function (
      this: LifecycleState,
      name: string
    ) {
      const release = await acquireProjectLock.call(this, name);
      interleaving.projectLocks += 1;
      return async () => {
        interleaving.projectLocks -= 1;
        await release();
      };
    });
    vi.spyOn(LifecycleState.prototype, "acquireWorkspaceSetupLock").mockImplementation(async function (
      this: LifecycleState,
      name: string
    ) {
      interleaving.setupAttempts += 1;
      if (interleaving.setupAttempts === 1) {
        interleaving.projectHeldAtFirstSetup = interleaving.projectLocks > 0;
        interleaving.firstSetupAttempted.open();
        await interleaving.allowFirstSetup.wait;
      }
      return acquireSetupLock.call(this, name);
    });
  }
}

export function result(command: string, args: string[], stdout = "", exitCode = 0): CommandResult {
  return { command, args, stdout, stderr: "", exitCode };
}
