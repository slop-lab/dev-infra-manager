import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleOptions } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import { hostMirrorProvider } from "../../../../plugin-host-mirrors/src/index.js";
import {
  hostMirrorInspection,
  type HostMirrorOwnership
} from "../../../../plugin-host-mirrors/src/hostMirrorOwnership.js";

export const TEST_HOST_MIRROR_PROVIDER = {
  dockerImage: "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
  aptImage: "sameersbn/apt-cacher-ng@sha256:58e74113cfac7e593201444648c105351cbfce7538bfb36dcafdc9479b2aefcc",
  ensure: hostMirrorProvider.ensure
} as const;

export const TEST_HOST_MIRROR_OWNERSHIP = {
  schemaVersion: 1,
  serviceId: "M".repeat(43),
  resourceIds: {
    "control-network": "N".repeat(43),
    "registry-cache-data": "V".repeat(43),
    "registry-cache": "R".repeat(43),
    "apt-cache-data": "D".repeat(43),
    "apt-cache": "A".repeat(43)
  }
} satisfies HostMirrorOwnership;

export function seedTestHostMirrorOwnership(stateRoot: string): void {
  mkdirSync(join(stateRoot, "services"), { recursive: true });
  writeFileSync(join(stateRoot, "services", "host-mirrors.json"), `${JSON.stringify(TEST_HOST_MIRROR_OWNERSHIP)}\n`);
}

export function registryCacheInspect(image: string, id = "registry-id"): string {
  return `${id}|${hostMirrorInspection("registry-cache", TEST_HOST_MIRROR_OWNERSHIP)}|true|${image}|dim-control|volume:dim-registry-cache-data:/var/lib/registry:true|${JSON.stringify([
    "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
    "REGISTRY_PROXY_TTL=168h",
    "REGISTRY_STORAGE_DELETE_ENABLED=true",
    "REGISTRY_LOG_LEVEL=info",
    "OTEL_TRACES_EXPORTER=none"
  ])}|unless-stopped|${JSON.stringify(["dim-registry-cache"])}\n`;
}

export function hostMirrorOptions(stateRoot: string): LifecycleOptions {
  seedTestHostMirrorOwnership(stateRoot);
  return {
    stateRoot,
    controllerRuntimeDirectory: "/run/dim",
    controllerSocketPath: "/run/dim/controller.sock",
    adminControllerSocketPath: "/run/dim/admin.sock",
    hostMirrorProvider: TEST_HOST_MIRROR_PROVIDER
  };
}
