import type { ControlPlaneDockerCommandResult } from "../../../../core/packages/installer/src/controlPlaneDocker.js";

export const isolationRuntimeFaults = [
  "devices",
  "deviceRequests",
  "deviceCgroupRules",
  "pidMode",
  "ipcMode",
  "utsMode",
  "cgroupnsMode",
  "usernsMode",
  "networkMode"
] as const;

export type RuntimeFault =
  | "command"
  | "image"
  | "mount"
  | "port"
  | "user"
  | "security"
  | (typeof isolationRuntimeFaults)[number];

export type RuntimeService = {
  readonly service: "native-git" | "ordinary-ci";
  readonly image: string;
  readonly generationPath: string;
  readonly generationId: string;
  readonly publishHost: string;
  readonly publishPort: number;
  readonly fault?: RuntimeFault;
};

export function runtimeContainer(runtime: RuntimeService, includeIsolation: boolean): ControlPlaneDockerCommandResult {
  const native = runtime.service === "native-git";
  const prefix = runtime.service;
  const stateTarget = native ? "/var/lib/dim-native-git" : "/var/lib/dim-ordinary-ci";
  const mounts = [
    { Type: "bind", Source: `${runtime.generationPath}/${prefix}.json`, Destination: "/run/secrets/service.json", RW: false },
    { Type: "bind", Source: `${runtime.generationPath}/${prefix}-readiness.token`, Destination: "/run/secrets/readiness.token", RW: false },
    { Type: "bind", Source: `${runtime.generationPath}/${prefix}-activation.token`, Destination: "/run/secrets/activation.token", RW: false },
    {
      Type: "volume", Name: `dim-control-plane-${prefix}-data`,
      Source: `/var/lib/docker/volumes/dim-control-plane-${prefix}-data/_data`, Destination: stateTarget, RW: true
    }
  ];
  const firstMount = mounts[0];
  if (runtime.fault === "mount" && firstMount !== undefined) mounts[0] = { ...firstMount, Source: "/foreign/service.json" };
  const ports = { "8080/tcp": [{ HostIp: runtime.publishHost, HostPort: String(runtime.publishPort) }] };
  if (runtime.fault === "port") ports["8080/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "7999" }];
  const imageId = `sha256:${(native ? "d" : "e").repeat(64)}`;
  const fields = [
    runtime.fault === "image" ? `sha256:${"f".repeat(64)}` : imageId,
    runtime.image,
    runtime.fault === "user" ? "0:0" : native ? "10001:10001" : "10002:10002",
    JSON.stringify(runtime.fault === "command"
      ? ["serve", "/run/secrets/service.json", "f".repeat(64)]
      : ["serve", "/run/secrets/service.json", runtime.generationId]),
    JSON.stringify(mounts), JSON.stringify(ports), JSON.stringify({ "dim-control-plane": {} }),
    runtime.fault === "security" ? "false" : "true",
    "false",
    JSON.stringify(["ALL"]),
    JSON.stringify(["no-new-privileges:true"]),
    JSON.stringify({ "/tmp": "rw,nosuid,nodev,noexec,mode=1777" })
  ];
  if (includeIsolation) fields.push(
    JSON.stringify(runtime.fault === "devices"
      ? [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }]
      : null),
    JSON.stringify(runtime.fault === "deviceRequests"
      ? [{ Driver: "nvidia", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]], Options: {} }]
      : null),
    JSON.stringify(runtime.fault === "deviceCgroupRules" ? ["c 1:3 rwm"] : null),
    JSON.stringify(runtime.fault === "pidMode" ? "host" : ""),
    JSON.stringify(runtime.fault === "ipcMode" ? "host" : "private"),
    JSON.stringify(runtime.fault === "utsMode" ? "host" : ""),
    JSON.stringify(runtime.fault === "cgroupnsMode" ? "host" : "private"),
    JSON.stringify(runtime.fault === "usernsMode" ? "host" : ""),
    JSON.stringify(runtime.fault === "networkMode" ? "host" : "dim-control-plane")
  );
  return { exitCode: 0, stdout: `${fields.join("\n")}\n`, stderr: "" };
}

export function runtimeFromCompose(text: string, service: "native-git" | "ordinary-ci"): RuntimeService {
  const section = new RegExp(`  ${service}:\\n([\\s\\S]*?)(?=\\n  (?:native-git|ordinary-ci):|\\nvolumes:)`).exec(text)?.[1];
  const image = /    image: "([^"]+)"/.exec(section ?? "")?.[1];
  const configSource = new RegExp(`source: "([^"]+/${service}\\.json)"`).exec(section ?? "")?.[1];
  const publishPortText = /        published: "([0-9]+)"/.exec(section ?? "")?.[1];
  const publishHost = /        host_ip: "([^"]+)"/.exec(section ?? "")?.[1];
  const generationId = /      - "([0-9a-f]{64})"/.exec(section ?? "")?.[1];
  if (image === undefined || configSource === undefined || publishPortText === undefined || publishHost === undefined
    || generationId === undefined) {
    throw new Error("Compose runtime fixture is malformed");
  }
  return {
    service,
    image,
    generationPath: configSource.slice(0, -(`/${service}.json`.length)),
    generationId,
    publishHost,
    publishPort: Number(publishPortText)
  };
}
