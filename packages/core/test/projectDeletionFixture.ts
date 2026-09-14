import type { LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";

export const project = {
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
    hostUrl: "http://host/dim-project/root.git",
    workspaceUrl: "http://dim-gitea:3000/dim-project/root.git",
    phase: "ready",
    connections: [],
    protectedPatterns: ["main"],
    protectionPhase: "applied",
    createdAt: "now",
    updatedAt: "now"
  }],
  createdAt: "now",
  updatedAt: "now"
} satisfies ProjectRecord;

export function lifecycleOptions(stateRoot: string): LifecycleOptions {
  return {
    stateRoot,
    giteaImage: "gitea",
    giteaHost: "gitea",
    giteaPort: 3000,
    giteaAdminUsername: "admin",
    gitUsername: "writer",
    gitMaintainerUsername: "maintainer",
    defaultWorkspaceBackend: "sysbox",
    cpuCount: "4",
    memory: "8GiB",
    pidsLimit: "2048",
    controllerRuntimeDirectory: "/run/dim",
    controllerSocketPath: "/run/dim/controller.sock",
    agentControllerSocketPath: "/run/dim/agent.sock",
    adminControllerSocketPath: "/run/dim/admin.sock",
    ciRunnerImage: "runner",
    ciRunnerRuntime: "sysbox-runc",
    ciRunnerDefaultCpus: "4",
    ciRunnerDefaultMemory: "8GiB",
    ciRunnerDefaultPidsLimit: "2048"
  };
}

export class Barrier {
  readonly promise: Promise<void>;
  private resolvePromise: () => void = () => undefined;

  constructor() {
    this.promise = new Promise((resolve) => { this.resolvePromise = resolve; });
  }

  open(): void {
    this.resolvePromise();
  }
}
