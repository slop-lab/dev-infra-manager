import { describe, expect, it } from "vitest";
import { resolveWorkspaceTarget } from "../../../../core/packages/core/src/controller.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const workspace = {
  schemaVersion: 7,
  name: "work",
  projectId: "project",
  projectName: "project",
  rootRepositoryAlias: "root",
  rootRef: "refs/heads/main",
  rootCommit: "a".repeat(40),
  workspaceDataPath: "/var/lib/dim/workspace-data",
  phase: "ready",
  profiles: [],
  composeProjectName: "dim-work",
  containerName: "dim-ws-work",
  networkName: "dim-control",
  dockerVolumeName: "dim-ws-work-docker",
  runtimeBackend: "sysbox",
  kvm: false,
  cpuCount: "2",
  memory: "4g",
  pidsLimit: "2048",
  routes: [],
  gitUserName: "Agent",
  gitUserEmail: "agent@example.invalid",
  gitBaseUrl: "http://dim-gitea:3000/project",
  hostAliases: {},
  projectManifestPath: "/run/dim/project.json",
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z"
} satisfies WorkspaceRecord;

describe("resolved workspace target identity", () => {
  it("fingerprints the nested leaf generation when the relay endpoint is stable", async () => {
    // Given: a nested leaf with a stable published port and a distinct container identity.
    const runner = new TargetRunner("leaf-generation-2");

    // When: core resolves the two-level target through its stable outer relay.
    const resolved = await resolveWorkspaceTarget(runner, workspace, {
      containers: ["parent", "leaf"],
      port: 8080,
      protocol: "tcp"
    }, "container-ip");

    // Then: consumers receive leaf identity in addition to the stable network endpoint.
    expect(resolved).toMatchObject({
      host: "172.20.0.10",
      port: expect.any(Number),
      fingerprint: "leaf-generation-2"
    });
  });
});

class TargetRunner implements StreamingCommandRunner {
  constructor(private readonly leafId: string) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    const output = (stdout: string): CommandResult => ({ command, args, stdout, stderr: "", exitCode: 0 });
    if (args.at(-3) === "leaf" && args.at(-2) === "--format") {
      const binding = { "8080/tcp": [{ HostPort: "32000" }] };
      return output(JSON.stringify({
        Id: this.leafId,
        ...binding,
        NetworkSettings: { Ports: binding }
      }));
    }
    if (args.at(-3) === "parent" && args.at(-2) === "--format") {
      return output(JSON.stringify({
        Id: "parent-generation",
        Name: "/parent",
        NetworkSettings: { Networks: { bridge: { IPAddress: "172.18.0.2" } } }
      }));
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return output(JSON.stringify({
        Id: "workspace-generation",
        NetworkSettings: { Networks: { "dim-control": { IPAddress: "172.20.0.10" } } }
      }));
    }
    return output("");
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}
