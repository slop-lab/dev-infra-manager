import { join } from "node:path";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { COMMIT, HEAD_COMMIT, INITIAL_COMMIT, SOURCE_COMMIT } from "./workspaceUpdateLockRunner.js";

export function options(stateRoot: string) {
  return lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot });
}

export function projectFixture(): ProjectRecord {
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
    }, {
      alias: "source",
      ref: "refs/heads/development",
      providerRepoId: "dim-project/source",
      owner: "dim-project",
      hostUrl: "http://host/source.git",
      workspaceUrl: "http://workspace/source.git",
      phase: "ready",
      connections: [],
      protectedPatterns: [],
      protectionPhase: "applied",
      createdAt: "now",
      updatedAt: "now"
    }, {
      alias: "head",
      providerRepoId: "dim-project/head",
      owner: "dim-project",
      hostUrl: "http://host/head.git",
      workspaceUrl: "http://workspace/head.git",
      phase: "ready",
      connections: [],
      protectedPatterns: [],
      protectionPhase: "applied",
      createdAt: "now",
      updatedAt: "now"
    }],
    createdAt: "now",
    updatedAt: "now"
  };
}

export function repositorySnapshot(rootCommit = COMMIT) {
  return {
    head: {
      workspaceUrl: "http://workspace/head.git",
      phase: "ready",
      root: false,
      requestedRef: "HEAD",
      ref: "refs/heads/trunk",
      commit: HEAD_COMMIT
    },
    root: {
      workspaceUrl: "http://workspace/root.git",
      phase: "ready",
      root: true,
      requestedRef: "refs/heads/main",
      ref: "refs/heads/main",
      commit: rootCommit
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

export function workspaceFixture(stateRoot: string, project: ProjectRecord): WorkspaceRecord {
  return {
    schemaVersion: 6,
    name: "work-1",
    projectId: project.id,
    projectName: project.name,
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: INITIAL_COMMIT,
    rootSnapshotPath: join(stateRoot, "assets", "project-roots", project.id, INITIAL_COMMIT),
    workspaceDataPath: "/var/lib/dim/workspace-data",
    phase: "ready",
    profiles: ["development"],
    composeProjectName: "dim-work-1",
    containerName: "dim-ws-work-1",
    networkName: "dim-control",
    dockerVolumeName: "dim-ws-work-1-docker",
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "2",
    memory: "4g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-project",
    hostAliases: { "dim-gitea": ["172.20.0.2"] },
    projectManifestPath: "/run/dim/project.json",
    createdAt: "now",
    updatedAt: "now"
  };
}
