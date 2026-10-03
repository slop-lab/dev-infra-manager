import type { ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { ownedGiteaContainerInspect, ownedGiteaResourceInspect } from "./giteaServiceFixture.js";
import { workspaceContainerInspect, workspaceVolumeInspect } from "./workspaceOwnershipFixture.js";
import { hostMirrorInspection } from "../../../../core/packages/core/src/hostMirrorOwnership.js";
import { registryCacheInspect, TEST_HOST_MIRROR_OWNERSHIP } from "./hostLifecycleFixture.js";


export const COMMIT = "a".repeat(40);

export const SOURCE_COMMIT = "b".repeat(40);

export const MOVED_SOURCE_COMMIT = "c".repeat(40);

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

export class LifecycleRunner implements StreamingCommandRunner {
  readonly runCalls: string[][] = [];
  readonly streamingCalls: string[][] = [];
  readonly publishedManifests: Record<string, unknown>[] = [];
  containerInspect = workspaceContainerInspect(WORKSPACE_IDENTITY);
  constructor(private readonly lifecycleFiles = new Set([".dim/setup.sh", ".dim/entrypoint.sh"])) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runCalls.push([command, ...args]);
    if (command === "git" && args.includes("ls-remote")) {
      return { command, args, stdout: `${MOVED_SOURCE_COMMIT}\trefs/heads/development\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const stdout = args.some((argument) => argument.includes("dim.service-id"))
        ? ownedGiteaResourceInspect("network")
      : hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP);
      return { command, args, stdout: `${stdout}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const stdout = args[2] === WORKSPACE_IDENTITY.dockerVolumeName
        ? `${workspaceVolumeInspect(WORKSPACE_IDENTITY)}\n`
        : args[2] === "dim-gitea-data"
          ? `${ownedGiteaResourceInspect("volume")}\n`
      : `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`;
      return { command, args, stdout, stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-gitea") {
      return {
        command,
        args,
        stdout: `${ownedGiteaContainerInspect("gitea-container-id", true)}\n`,
        stderr: "",
        exitCode: 0
      };
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-registry-cache") {
      return {
        command,
        args,
        stdout: registryCacheInspect("registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33"),
        stderr: "",
        exitCode: 0
      };
    }
    if (args[0] === "exec" && (args[1] === "dim-gitea" || args[1] === "gitea-container-id")
      && args.some((argument) => argument.includes("/data/dim/credentials.json"))) {
      return { command, args, stdout: JSON.stringify({
        adminUsername: "admin", adminPassword: "admin-secret",
        writerUsername: "writer", writerPassword: "writer-secret",
        maintainerUsername: "maintainer", maintainerPassword: "maintainer-secret"
      }), stderr: "", exitCode: 0 };
    }
    if (args.includes("gitea") && args.includes("admin")) {
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "exec" && args[1] === "--user" && args[3] === "gitea-container-id"
      && args[4] === "sh" && args[5] === "-c") {
      return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "exec" && args.at(-2) === "docker" && args.at(-1) === "info") {
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args.some((argument) => argument.includes(".Config.Labels"))) {
      return { command, args, stdout: `${this.containerInspect}\n`, stderr: "", exitCode: 0 };
    }
    if (args.some((argument) => argument.startsWith("DIM_HOST_INPUT_HELPER_B64="))) {
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "rm") {
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "run") {
      const rootMount = args.find((argument) => argument.includes("target=/run/dim/project-root"));
      const rootSnapshotPath = rootMount?.match(/source=([^,]+)/)?.[1] ?? "missing";
      this.containerInspect = workspaceContainerInspect(WORKSPACE_IDENTITY, { rootSnapshotPath });
      return { command, args, stdout: "workspace-container-id\n", stderr: "", exitCode: 0 };
    }
    if (args.includes("-f")) {
      return {
        command,
        args,
        stdout: "",
        stderr: "",
        exitCode: this.lifecycleFiles.has(args.at(-1) ?? "") ? 0 : 1
      };
    }
    const manifest = args.find((argument) => argument.startsWith("DIM_PROJECT_MANIFEST_B64="));
    if (manifest !== undefined) {
      const encoded = manifest.split("=", 2)[1];
      if (encoded !== undefined) {
        this.publishedManifests.push(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
      }
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args.includes("merge") && args.includes("--ff-only")) {
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "exec" && args[4] === "sh" && args[5] === "-c") {
      return { command, args, stdout: "none\ncgroup2fs\nno\npids\n", stderr: "", exitCode: 0 };
    }
    return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streamingCalls.push([command, ...args]);
    return 0;
  }
}

export function projectFixture(): ProjectRecord {
  const repository = (alias: string, ref?: string) => ({
    alias,
    ...(ref === undefined ? {} : { ref }),
    providerRepoId: `dim-project/${alias}`,
    owner: "dim-project",
    hostUrl: `http://host/${alias}.git`,
    workspaceUrl: `http://workspace/${alias}.git`,
    phase: "ready" as const,
    connections: [],
    protectedPatterns: alias === "root" ? ["main"] : [],
    protectionPhase: "applied" as const,
    createdAt: "now",
    updatedAt: "now"
  });
  return {
    schemaVersion: 4,
    id: "project-id",
    name: "project",
    gitNamespace: "dim-project",
    giteaOrganizationId: 41,
    phase: "ready",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    repositories: [repository("root"), repository("source", "refs/heads/development")],
    createdAt: "now",
    updatedAt: "now"
  };
}

export function repositorySnapshot() {
  return {
    root: {
      workspaceUrl: "http://workspace/root.git",
      phase: "ready",
      root: true,
      requestedRef: "refs/heads/main",
      ref: "refs/heads/main",
      commit: COMMIT
    },
    source: {
      workspaceUrl: "http://workspace/source.git",
      phase: "ready",
      root: false,
      requestedRef: "refs/heads/development",
      ref: "refs/heads/development",
      commit: SOURCE_COMMIT
    }
  } as const;
}
