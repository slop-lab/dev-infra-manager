import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { GiteaServiceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";

export const TEST_GITEA_SERVICE = {
  schemaVersion: 2,
  serviceId: "S".repeat(43),
  containerOwnershipId: "C".repeat(43),
  networkOwnershipId: "N".repeat(43),
  volumeOwnershipId: "V".repeat(43),
  phase: "ready",
  containerName: "dim-gitea",
  networkName: "dim-control",
  volumeName: "dim-gitea-data",
  image: "gitea/gitea:1.27.0",
  imageId: `sha256:${"a".repeat(64)}`,
  networkId: "b".repeat(64),
  resourcesEstablished: true,
  port: 3000,
  endpointAddress: "172.20.0.2",
  createdAt: "before",
  updatedAt: "before"
} as const satisfies GiteaServiceRecord;

export async function claimTestGiteaService(
  stateRoot: string,
  port: number = TEST_GITEA_SERVICE.port,
  image: string = TEST_GITEA_SERVICE.image
): Promise<void> {
  await new LifecycleState(stateRoot).claimGiteaService({ ...TEST_GITEA_SERVICE, port, image });
}

export function ownedGiteaContainerInspect(id: string, running: boolean, managed = true): string {
  return [
    id,
    String(managed),
    "dim",
    TEST_GITEA_SERVICE.serviceId,
    "gitea",
    TEST_GITEA_SERVICE.containerOwnershipId,
    String(running),
    TEST_GITEA_SERVICE.endpointAddress,
    TEST_GITEA_SERVICE.networkId,
    TEST_GITEA_SERVICE.imageId,
    "volume",
    TEST_GITEA_SERVICE.volumeName,
    "true"
  ].join("|");
}

export function ownedGiteaResourceInspect(type: "network" | "volume"): string {
  return [
    ...(type === "network" ? [TEST_GITEA_SERVICE.networkId] : []),
    "true",
    "dim",
    TEST_GITEA_SERVICE.serviceId,
    type === "network" ? "network" : "gitea-data",
    type === "network" ? TEST_GITEA_SERVICE.networkOwnershipId : TEST_GITEA_SERVICE.volumeOwnershipId
  ].join("|");
}
