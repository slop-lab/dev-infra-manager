import { UserError } from "./errors.js";
import {
  GITEA_NETWORK,
  GITEA_VOLUME,
  type GiteaResourceLease
} from "./giteaContainer.js";
import type { CommandRunner } from "./types.js";

type ResourcePlan = {
  readonly type: "network" | "volume";
  readonly inspectArgs: readonly string[];
  readonly createArgs: readonly string[];
  readonly name: string;
  readonly serviceId: string;
  readonly ownershipId: string;
  readonly expectedDockerId?: string;
};

const missingResourceDiagnostic = {
  network: (name: string) => `Error response from daemon: network ${name} not found`,
  volume: (name: string) => `Error response from daemon: get ${name}: no such volume`
} as const satisfies Record<ResourcePlan["type"], (name: string) => string>;

export async function resolveGiteaImageId(runner: CommandRunner, image: string): Promise<string> {
  assertCommand(await runner.run("docker", ["pull", image]), "pull Gitea image");
  const inspected = await runner.run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]) ;
  assertCommand(inspected, "inspect Gitea image");
  const imageId = inspected.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new UserError("Docker returned an invalid Gitea image ID");
  return imageId;
}

export async function ensureGiteaBaseResources(
  runner: CommandRunner,
  lease: GiteaResourceLease,
  allowCreation: boolean
): Promise<string> {
  const networkId = await ensureResource(runner, {
    type: "network",
    inspectArgs: ["network", "inspect", GITEA_NETWORK, "--format", "{{.Id}}|{{index .Labels \"dim.managed\"}}|{{index .Labels \"dim.owner\"}}|{{index .Labels \"dim.service-id\"}}|{{index .Labels \"dim.resource\"}}|{{index .Labels \"dim.resource-id\"}}"],
    createArgs: [
      "network", "create", "--label", "dim.managed=true", "--label", "dim.owner=dim",
      "--label", `dim.service-id=${lease.serviceId}`, "--label", "dim.resource=network",
      "--label", `dim.resource-id=${lease.networkOwnershipId}`, GITEA_NETWORK
    ],
    name: GITEA_NETWORK,
    serviceId: lease.serviceId,
    ownershipId: lease.networkOwnershipId,
    ...(lease.networkId === undefined ? {} : { expectedDockerId: lease.networkId })
  }, allowCreation);
  await ensureResource(runner, {
    type: "volume",
    inspectArgs: ["volume", "inspect", GITEA_VOLUME, "--format", "{{index .Labels \"dim.managed\"}}|{{index .Labels \"dim.owner\"}}|{{index .Labels \"dim.service-id\"}}|{{index .Labels \"dim.resource\"}}|{{index .Labels \"dim.resource-id\"}}"],
    createArgs: [
      "volume", "create", "--label", "dim.managed=true", "--label", "dim.owner=dim",
      "--label", `dim.service-id=${lease.serviceId}`, "--label", "dim.resource=gitea-data",
      "--label", `dim.resource-id=${lease.volumeOwnershipId}`, GITEA_VOLUME
    ],
    name: GITEA_VOLUME,
    serviceId: lease.serviceId,
    ownershipId: lease.volumeOwnershipId
  }, allowCreation);
  return networkId;
}

async function ensureResource(runner: CommandRunner, plan: ResourcePlan, allowCreation: boolean): Promise<string> {
  let inspected = await runner.run("docker", [...plan.inspectArgs]);
  if (inspected.exitCode !== 0) {
    if (inspected.stderr.trim().toLowerCase() !== missingResourceDiagnostic[plan.type](plan.name).toLowerCase()) {
      throw new UserError(`Failed to inspect Docker ${plan.type} '${plan.name}': ${inspected.stderr.trim()}`);
    }
    if (!allowCreation) throw new UserError(`Established Docker ${plan.type} '${plan.name}' is missing`);
    assertCommand(await runner.run("docker", [...plan.createArgs]), `create Docker ${plan.type}`);
    inspected = await runner.run("docker", [...plan.inspectArgs]);
    assertCommand(inspected, `inspect created Docker ${plan.type}`);
  }
  const fields = inspected.stdout.trim().split("|");
  const offset = plan.type === "network" ? 1 : 0;
  const dockerId = plan.type === "network" ? fields[0] : plan.name;
  const resource = plan.type === "network" ? "network" : "gitea-data";
  if (fields.length !== 5 + offset || fields[offset] !== "true" || fields[offset + 1] !== "dim"
    || fields[offset + 2] !== plan.serviceId || fields[offset + 3] !== resource
    || fields[offset + 4] !== plan.ownershipId || dockerId === undefined || dockerId.length === 0) {
    throw new UserError(`Docker resource '${plan.name}' exists but is not managed by dim`);
  }
  if (plan.expectedDockerId !== undefined && dockerId !== plan.expectedDockerId) {
    throw new UserError(`Docker network '${plan.name}' identity changed`);
  }
  return dockerId;
}

function assertCommand(
  result: { readonly exitCode: number; readonly stdout?: string; readonly stderr: string },
  action: string
): void {
  if (result.exitCode !== 0) throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout || "").trim()}`);
}
