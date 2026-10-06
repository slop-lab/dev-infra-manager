import { isAbsolute } from "node:path";
import type { ControlPlanePublish } from "./controlPlaneConfig.js";

type ControlPlaneComposeServiceConfig = {
  readonly image: string;
  readonly publish: ControlPlanePublish;
};

export type ControlPlaneComposeConfig = {
  readonly deploymentId: string;
  readonly nativeGit: ControlPlaneComposeServiceConfig;
  readonly ordinaryCi: ControlPlaneComposeServiceConfig;
};

export type ControlPlaneServiceSnapshots = {
  readonly config: string;
  readonly readinessToken: string;
  readonly activationToken: string;
};

export type ControlPlaneSnapshotPaths = {
  readonly nativeGit: ControlPlaneServiceSnapshots;
  readonly ordinaryCi: ControlPlaneServiceSnapshots;
};

export type ControlPlaneComposeInput = {
  readonly generationId: string;
  readonly config: ControlPlaneComposeConfig;
  readonly snapshots: ControlPlaneSnapshotPaths;
  readonly operatorSourcePaths: readonly string[];
  readonly forbiddenSecrets: readonly string[];
};

type ServiceRender = {
  readonly name: "native-git" | "ordinary-ci";
  readonly uid: "10001:10001" | "10002:10002";
  readonly stateVolume: "dim-control-plane-native-git-data" | "dim-control-plane-ordinary-ci-data";
  readonly stateTarget: "/var/lib/dim-native-git" | "/var/lib/dim-ordinary-ci";
  readonly config: ControlPlaneComposeServiceConfig;
  readonly snapshots: ControlPlaneServiceSnapshots;
};

export function renderControlPlaneCompose(input: ControlPlaneComposeInput): Buffer {
  validateSnapshotPaths(input);
  const services = [
    {
      name: "native-git", uid: "10001:10001", stateVolume: "dim-control-plane-native-git-data",
      stateTarget: "/var/lib/dim-native-git", config: input.config.nativeGit, snapshots: input.snapshots.nativeGit
    },
    {
      name: "ordinary-ci", uid: "10002:10002", stateVolume: "dim-control-plane-ordinary-ci-data",
      stateTarget: "/var/lib/dim-ordinary-ci", config: input.config.ordinaryCi, snapshots: input.snapshots.ordinaryCi
    }
  ] satisfies readonly ServiceRender[];
  const lines = ['name: "dim-control-plane"', "services:"];
  for (const service of services) lines.push(...renderService(service, input.config.deploymentId, input.generationId));
  lines.push("volumes:");
  lines.push(...renderVolume("dim-control-plane-native-git-data", "native-git", input.config.deploymentId));
  lines.push(...renderVolume("dim-control-plane-ordinary-ci-data", "ordinary-ci", input.config.deploymentId));
  lines.push("networks:", "  dim-control-plane:", '    name: "dim-control-plane"', "    driver: bridge", "    labels:");
  lines.push(...renderLabels("network", input.config.deploymentId, undefined, 6));
  const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  for (const secret of input.forbiddenSecrets) {
    if (secret.length > 0 && bytes.includes(Buffer.from(secret))) {
      throw new ControlPlaneComposeError("rendered Compose bytes contain a forbidden secret");
    }
  }
  return bytes;
}

export class ControlPlaneComposeError extends Error {
  readonly name = "ControlPlaneComposeError";
}

function renderService(service: ServiceRender, deploymentId: string, generationId: string): readonly string[] {
  return [
    `  ${service.name}:`,
    `    image: ${quoted(service.config.image)}`,
    "    command:",
    '      - "serve"',
    '      - "/run/secrets/service.json"',
    `      - ${quoted(generationId)}`,
    `    user: ${quoted(service.uid)}`,
    "    read_only: true",
    "    cap_drop:",
    '      - "ALL"',
    "    security_opt:",
    '      - "no-new-privileges:true"',
    "    tmpfs:",
    '      - "/tmp:rw,nosuid,nodev,noexec,mode=1777"',
    "    ports:",
    "      - target: 8080",
    `        published: ${quoted(String(service.config.publish.port))}`,
    `        host_ip: ${quoted(service.config.publish.host)}`,
    "        protocol: tcp",
    "    volumes:",
    ...bindMount(service.snapshots.config, "/run/secrets/service.json"),
    ...bindMount(service.snapshots.readinessToken, "/run/secrets/readiness.token"),
    ...bindMount(service.snapshots.activationToken, "/run/secrets/activation.token"),
    "      - type: volume",
    `        source: ${service.stateVolume}`,
    `        target: ${quoted(service.stateTarget)}`,
    "    networks:",
    "      - dim-control-plane",
    "    labels:",
    ...renderLabels("service", deploymentId, service.name, 6)
  ];
}

function bindMount(source: string, target: string): readonly string[] {
  return [
    "      - type: bind",
    `        source: ${quoted(source)}`,
    `        target: ${quoted(target)}`,
    "        read_only: true"
  ];
}

function renderVolume(name: string, service: "native-git" | "ordinary-ci", deploymentId: string): readonly string[] {
  return [
    `  ${name}:`,
    `    name: ${quoted(name)}`,
    "    labels:",
    ...renderLabels("volume", deploymentId, service, 6)
  ];
}

function renderLabels(
  resource: "network" | "volume" | "service",
  deploymentId: string,
  service: "native-git" | "ordinary-ci" | undefined,
  spaces: number
): readonly string[] {
  const indentation = " ".repeat(spaces);
  return [
    `${indentation}org.dim.managed: "true"`,
    `${indentation}org.dim.bundle: "control-plane"`,
    `${indentation}org.dim.deployment: ${quoted(deploymentId)}`,
    `${indentation}org.dim.resource: ${quoted(resource)}`,
    ...(service === undefined ? [] : [`${indentation}org.dim.service: ${quoted(service)}`])
  ];
}

function validateSnapshotPaths(input: ControlPlaneComposeInput): void {
  const paths = [
    input.snapshots.nativeGit.config,
    input.snapshots.nativeGit.readinessToken,
    input.snapshots.nativeGit.activationToken,
    input.snapshots.ordinaryCi.config,
    input.snapshots.ordinaryCi.readinessToken,
    input.snapshots.ordinaryCi.activationToken
  ];
  if (paths.some((path) => !isAbsolute(path) || path.includes("\0"))) {
    throw new ControlPlaneComposeError("generation snapshot paths must be absolute");
  }
  if (new Set(paths).size !== paths.length) throw new ControlPlaneComposeError("generation snapshot paths must be distinct");
  const operatorPaths = new Set(input.operatorSourcePaths);
  if (paths.some((path) => operatorPaths.has(path))) {
    throw new ControlPlaneComposeError("mutable operator source paths must not be mounted");
  }
}

function quoted(value: string): string {
  return JSON.stringify(value);
}
