import type { ControlPlaneComposeConfig } from "./controlPlaneCompose.js";
import { ControlPlaneDockerError, type ControlPlaneDockerRunner } from "./controlPlaneDockerTypes.js";
import { assertControlPlaneRuntimeIsolation } from "./controlPlaneRuntimeIsolation.js";
import type { ControlPlaneInstalledState } from "./controlPlaneState.js";

const outputLimit = 64 * 1024;
const inspectTimeout = 10_000;
const containerFormat = [
  "{{.Image}}",
  "{{.Config.Image}}",
  "{{.Config.User}}",
  "{{json .Config.Cmd}}",
  "{{json .Mounts}}",
  "{{json .NetworkSettings.Ports}}",
  "{{json .NetworkSettings.Networks}}",
  "{{.HostConfig.ReadonlyRootfs}}",
  "{{.HostConfig.Privileged}}",
  "{{json .HostConfig.CapDrop}}",
  "{{json .HostConfig.SecurityOpt}}",
  "{{json .HostConfig.Tmpfs}}",
  "{{json .HostConfig.Devices}}",
  "{{json .HostConfig.DeviceRequests}}",
  "{{json .HostConfig.DeviceCgroupRules}}",
  "{{json .HostConfig.PidMode}}",
  "{{json .HostConfig.IpcMode}}",
  "{{json .HostConfig.UTSMode}}",
  "{{json .HostConfig.CgroupnsMode}}",
  "{{json .HostConfig.UsernsMode}}",
  "{{json .HostConfig.NetworkMode}}"
].join("\n");

type Service = "native-git" | "ordinary-ci";

type ServiceExpectation = {
  readonly service: Service;
  readonly image: string;
  readonly user: "10001:10001" | "10002:10002";
  readonly volume: string;
  readonly stateTarget: string;
  readonly publishHost: string;
  readonly publishPort: number;
  readonly generationId: string;
  readonly containerId?: string;
  readonly snapshots: readonly { readonly source: string; readonly destination: string }[];
};

type ControlPlaneRuntimeTarget = {
  readonly config: ControlPlaneComposeConfig;
  readonly generationPath: string;
  readonly generationId: string;
  readonly images?: { readonly nativeGit: string; readonly ordinaryCi: string };
};

export async function assertControlPlaneRuntimeTopology(
  runner: ControlPlaneDockerRunner,
  installed: ControlPlaneInstalledState
): Promise<void> {
  const expectations = serviceExpectations({
    config: {
      deploymentId: installed.record.deploymentId,
      nativeGit: { image: installed.record.nativeGitImage, publish: installed.record.nativeGitPublish },
      ordinaryCi: { image: installed.record.ordinaryCiImage, publish: installed.record.ordinaryCiPublish }
    },
    generationPath: installed.generationPath,
    generationId: installed.record.generationId
  });
  for (const expected of expectations) await assertService(runner, expected);
}

export async function assertControlPlaneServiceRuntimeTopology(
  runner: ControlPlaneDockerRunner,
  target: ControlPlaneRuntimeTarget & { readonly service: Service; readonly containerId?: string }
): Promise<void> {
  const found = serviceExpectations(target).find((entry) => entry.service === target.service);
  const expected = found === undefined || target.containerId === undefined ? found : { ...found, containerId: target.containerId };
  if (expected === undefined) throw new ControlPlaneDockerError("control-plane runtime service expectation is missing");
  await assertService(runner, expected);
}

async function assertService(runner: ControlPlaneDockerRunner, expected: ServiceExpectation): Promise<void> {
  const imageResult = await run(runner, ["image", "inspect", expected.image, "--format", "{{.Id}}"]);
  if (imageResult.exitCode !== 0 || imageResult.stderr !== "" || !/^sha256:[0-9a-f]{64}\n$/.test(imageResult.stdout)) {
    throw new ControlPlaneDockerError("control-plane installed image identity is invalid");
  }
  const imageId = imageResult.stdout.slice(0, -1);
  const result = await run(runner, [
    "container", "inspect", expected.containerId ?? `dim-control-plane-${expected.service}-1`, "--format", containerFormat
  ]);
  if (result.exitCode !== 0 || result.stderr !== "") throw new ControlPlaneDockerError("control-plane running container inspection failed");
  const lines = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1).split("\n") : result.stdout.split("\n");
  if (lines.length !== 21 || lines[0] !== imageId || lines[1] !== expected.image || lines[2] !== expected.user) {
    throw new ControlPlaneDockerError("control-plane running image or user differs from installed state");
  }
  assertExactStrings(parseArray(lines[3]), ["serve", "/run/secrets/service.json", expected.generationId]);
  assertMounts(parseArray(lines[4]), expected);
  assertPorts(parseRecord(lines[5]), expected);
  const networks = parseRecord(lines[6]);
  if (Object.keys(networks).length !== 1 || !Object.hasOwn(networks, "dim-control-plane")) {
    throw new ControlPlaneDockerError("control-plane running network topology differs from installed state");
  }
  if (lines[7] !== "true" || lines[8] !== "false") {
    throw new ControlPlaneDockerError("control-plane running security topology differs from installed state");
  }
  assertExactStrings(parseArray(lines[9]), ["ALL"]);
  assertExactStrings(parseArray(lines[10]), ["no-new-privileges:true"]);
  const tmpfs = parseRecord(lines[11]);
  if (Object.keys(tmpfs).length !== 1 || tmpfs["/tmp"] !== "rw,nosuid,nodev,noexec,mode=1777") {
    throw new ControlPlaneDockerError("control-plane running security topology differs from installed state");
  }
  assertControlPlaneRuntimeIsolation({
    devices: lines[12],
    deviceRequests: lines[13],
    deviceCgroupRules: lines[14],
    pidMode: lines[15],
    ipcMode: lines[16],
    utsMode: lines[17],
    cgroupnsMode: lines[18],
    usernsMode: lines[19],
    networkMode: lines[20]
  }, "dim-control-plane");
}

function assertMounts(value: readonly unknown[], expected: ServiceExpectation): void {
  const wanted = [
    ...expected.snapshots.map((snapshot) => ({ type: "bind", source: snapshot.source, destination: snapshot.destination, writable: false })),
    { type: "volume", source: expected.volume, destination: expected.stateTarget, writable: true }
  ];
  if (value.length !== wanted.length) throw new ControlPlaneDockerError("control-plane running mount topology differs from installed state");
  for (const mount of wanted) {
    const match = value.find((entry) => isRecord(entry) && entry.Type === mount.type
      && (mount.type === "volume" ? entry.Name === mount.source : entry.Source === mount.source)
      && entry.Destination === mount.destination && entry.RW === mount.writable);
    if (match === undefined) throw new ControlPlaneDockerError("control-plane running mount topology differs from installed state");
  }
}

function assertPorts(value: Readonly<Record<string, unknown>>, expected: ServiceExpectation): void {
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "8080/tcp")) {
    throw new ControlPlaneDockerError("control-plane running port mapping differs from installed state");
  }
  const bindings = value["8080/tcp"];
  if (!Array.isArray(bindings) || bindings.length !== 1 || !isRecord(bindings[0])
    || Object.keys(bindings[0]).length !== 2 || bindings[0].HostIp !== expected.publishHost
    || bindings[0].HostPort !== String(expected.publishPort)) {
    throw new ControlPlaneDockerError("control-plane running port mapping differs from installed state");
  }
}

function serviceExpectations(target: ControlPlaneRuntimeTarget): readonly ServiceExpectation[] {
  const config = target.config;
  return [
    expectation({
      service: "native-git", image: target.images?.nativeGit ?? config.nativeGit.image, user: "10001:10001",
      volume: "dim-control-plane-native-git-data", stateTarget: "/var/lib/dim-native-git",
      publishHost: config.nativeGit.publish.host, publishPort: config.nativeGit.publish.port,
      generationPath: target.generationPath, generationId: target.generationId
    }),
    expectation({
      service: "ordinary-ci", image: target.images?.ordinaryCi ?? config.ordinaryCi.image, user: "10002:10002",
      volume: "dim-control-plane-ordinary-ci-data", stateTarget: "/var/lib/dim-ordinary-ci",
      publishHost: config.ordinaryCi.publish.host, publishPort: config.ordinaryCi.publish.port,
      generationPath: target.generationPath, generationId: target.generationId
    })
  ];
}

function assertExactStrings(actual: readonly unknown[], expected: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new ControlPlaneDockerError("control-plane running security topology differs from installed state");
  }
}

function expectation(input: Omit<ServiceExpectation, "snapshots"> & { readonly generationPath: string }): ServiceExpectation {
  const prefix = input.service === "native-git" ? "native-git" : "ordinary-ci";
  return {
    service: input.service, image: input.image, user: input.user, volume: input.volume,
    stateTarget: input.stateTarget, publishHost: input.publishHost, publishPort: input.publishPort,
    generationId: input.generationId,
    snapshots: [
      { source: `${input.generationPath}/${prefix}.json`, destination: "/run/secrets/service.json" },
      { source: `${input.generationPath}/${prefix}-readiness.token`, destination: "/run/secrets/readiness.token" },
      { source: `${input.generationPath}/${prefix}-activation.token`, destination: "/run/secrets/activation.token" }
    ]
  };
}

function parseArray(value: string | undefined): readonly unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new ControlPlaneDockerError("control-plane running topology is malformed");
  return parsed;
}

function parseRecord(value: string | undefined): Readonly<Record<string, unknown>> {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) throw new ControlPlaneDockerError("control-plane running topology is malformed");
  return parsed;
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) throw new ControlPlaneDockerError("control-plane running topology is malformed");
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneDockerError("control-plane running topology is malformed", { cause: error });
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function run(runner: ControlPlaneDockerRunner, args: readonly string[]) {
  const result = await runner.run({ args, timeoutMilliseconds: inspectTimeout, maximumOutputBytes: outputLimit });
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) {
    throw new ControlPlaneDockerError("control-plane running topology output exceeded its limit");
  }
  return result;
}
