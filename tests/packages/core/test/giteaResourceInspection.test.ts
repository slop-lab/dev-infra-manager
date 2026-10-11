import { describe, expect, it } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import {
  GITEA_NETWORK,
  GITEA_VOLUME
} from "../../../../core/packages/core/src/giteaContainer.js";
import { ensureGiteaBaseResources } from "../../../../core/packages/core/src/giteaResources.js";
import type { CommandResult, CommandRunner } from "../../../../core/packages/core/src/types.js";

type ResourceType = "network" | "volume";

type InspectionCase = {
  readonly resource: ResourceType;
  readonly diagnostic: string;
};

const LEASE = {
  serviceId: "S".repeat(43),
  containerOwnershipId: "C".repeat(43),
  networkOwnershipId: "N".repeat(43),
  volumeOwnershipId: "V".repeat(43),
  imageId: `sha256:${"a".repeat(64)}`,
  volumeName: GITEA_VOLUME
};

class ResourceInspectionRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly mutations: ResourceType[] = [];
  private readonly created = new Set<ResourceType>();

  constructor(
    private readonly failingResource: ResourceType,
    private readonly diagnostic: string
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === this.failingResource && args[1] === "inspect" && !this.created.has(this.failingResource)) {
      return result(command, args, { exitCode: 1, stderr: this.diagnostic });
    }
    if (args[1] === "inspect") {
      const resource = args[0] === "network" ? "network" : "gitea-data";
      const ownershipId = args[0] === "network" ? LEASE.networkOwnershipId : LEASE.volumeOwnershipId;
      return result(command, args, {
        exitCode: 0,
        stdout: `${args[0] === "network" ? `${"b".repeat(64)}|` : ""}true|dim|${LEASE.serviceId}|${resource}|${ownershipId}\n`
      });
    }
    if (args[1] === "create" && (args[0] === "network" || args[0] === "volume")) {
      this.created.add(args[0]);
      this.mutations.push(args[0]);
    }
    return result(command, args, { exitCode: 0 });
  }
}

function result(
  command: string,
  args: string[],
  output: { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }
): CommandResult {
  return {
    command,
    args,
    exitCode: output.exitCode,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? ""
  };
}

const missingDiagnostics = {
  network: `Error response from daemon: network ${GITEA_NETWORK} not found`,
  volume: `Error response from daemon: get ${GITEA_VOLUME}: no such volume`
} as const satisfies Record<ResourceType, string>;

const missingCases = [
  { resource: "network", diagnostic: missingDiagnostics.network },
  { resource: "network", diagnostic: `  ${missingDiagnostics.network.toUpperCase()}\n` },
  { resource: "volume", diagnostic: missingDiagnostics.volume },
  { resource: "volume", diagnostic: `\n${missingDiagnostics.volume.toUpperCase()}  ` }
] as const satisfies readonly InspectionCase[];

const rejectedCases = [
  { resource: "network", diagnostic: "Cannot connect to the Docker daemon" },
  { resource: "network", diagnostic: "permission denied while trying to connect to the Docker daemon socket" },
  { resource: "network", diagnostic: "Error response from daemon: network other-network not found" },
  { resource: "network", diagnostic: `Error response from daemon: get ${GITEA_NETWORK}: no such volume` },
  { resource: "network", diagnostic: `prefix ${missingDiagnostics.network}` },
  { resource: "network", diagnostic: `${missingDiagnostics.network} suffix` },
  { resource: "volume", diagnostic: "Cannot connect to the Docker daemon" },
  { resource: "volume", diagnostic: "permission denied while trying to connect to the Docker daemon socket" },
  { resource: "volume", diagnostic: "Error response from daemon: get other-volume: no such volume" },
  { resource: "volume", diagnostic: `Error response from daemon: network ${GITEA_VOLUME} not found` },
  { resource: "volume", diagnostic: `prefix ${missingDiagnostics.volume}` },
  { resource: "volume", diagnostic: `${missingDiagnostics.volume} suffix` }
] as const satisfies readonly InspectionCase[];

describe("managed Gitea Docker resource inspection", () => {
  it.each(missingCases)(
    "creates a missing $resource only for its exact type-specific diagnostic",
    async ({ resource, diagnostic }) => {
      // Given
      const runner = new ResourceInspectionRunner(resource, diagnostic);

      // When
      await ensureGiteaBaseResources(runner, LEASE, true);

      // Then
      expect(runner.mutations).toEqual([resource]);
    }
  );

  it.each(rejectedCases)(
    "rejects a $resource inspect diagnostic without creation or later reconciliation: $diagnostic",
    async ({ resource, diagnostic }) => {
      // Given
      const runner = new ResourceInspectionRunner(resource, diagnostic);

      // When
      const [outcome] = await Promise.allSettled([ensureGiteaBaseResources(runner, LEASE, true)]);

      // Then
      expect.soft(outcome).toMatchObject({ status: "rejected", reason: expect.any(UserError) });
      expect.soft(runner.mutations).toEqual([]);
      const failedInspection = runner.calls.findIndex(
        (call) => call[1] === resource && call[2] === "inspect"
      );
      expect.soft(failedInspection).toBeGreaterThanOrEqual(0);
      expect.soft(runner.calls.slice(failedInspection + 1)).toEqual([]);
    }
  );
});
