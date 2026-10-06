import { isAbsolute } from "node:path";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import {
  ControlPlaneImageProbeError,
  type ControlPlanePreflightStage
} from "./controlPlaneInstallError.js";
import {
  ControlPlaneDockerError,
  type ControlPlaneDockerCommandResult,
  type ControlPlaneDockerRunner,
  type ControlPlaneProbeSnapshots
} from "./controlPlaneDockerTypes.js";

const outputLimit = 64 * 1024;
const imageTimeout = 5 * 60_000;
const probeTimeout = 30_000;
const serviceExecutable = "/usr/local/bin/dim-service";

type ImageProbe = {
  readonly image: string;
  readonly user: "10001:10001" | "10002:10002";
  readonly source: string;
};

type HardenedProbe = ImageProbe & {
  readonly mounts: readonly string[];
  readonly command: readonly string[];
};

export function assertControlPlaneProbeSnapshots(config: ControlPlaneConfig, snapshots: ControlPlaneProbeSnapshots): void {
  const paths = [snapshots.nativeGit, snapshots.ordinaryCi];
  if (paths.some((path) => !isAbsolute(path) || path.includes("\0") || path.includes(",")) || new Set(paths).size !== paths.length) {
    throw new ControlPlaneDockerError("image probes require distinct absolute staged snapshot paths");
  }
  const operatorPaths = new Set([config.nativeGit.configFile, config.ordinaryCi.configFile]);
  if (paths.some((path) => operatorPaths.has(path))) {
    throw new ControlPlaneDockerError("image probes require staged snapshots, not mutable operator files");
  }
}

export async function probeControlPlaneImages(
  runner: ControlPlaneDockerRunner,
  config: ControlPlaneConfig,
  snapshots: ControlPlaneProbeSnapshots
): Promise<void> {
  const images = [
    { image: config.nativeGit.image, user: "10001:10001", source: snapshots.nativeGit },
    { image: config.ordinaryCi.image, user: "10002:10002", source: snapshots.ordinaryCi }
  ] as const satisfies readonly ImageProbe[];
  const pulledRefs: string[] = [];
  for (const image of images) {
    const service = image.user === "10001:10001" ? "native-git" : "ordinary-ci";
    await probeStage({
      stage: `${service} image pull`, pulledRefs, incompletePullRef: image.image,
      operation: () => pull(runner, image.image)
    });
    pulledRefs.push(image.image);
  }
  for (const image of images) {
    const service = image.user === "10001:10001" ? "native-git" : "ordinary-ci";
    await probeStage({
      stage: `${service} image verification`, pulledRefs,
      operation: () => inspectImage(runner, image)
    });
  }
  for (const image of images) {
    const service = image.user === "10001:10001" ? "native-git" : "ordinary-ci";
    await probeStage({
      stage: `${service} configuration`, pulledRefs,
      operation: () => runProbe(runner, serviceProbeArgs(image))
    });
  }
  await probeStage({
    stage: "bundle configuration", pulledRefs,
    operation: () => runProbe(runner, bundleProbeArgs(images[0], images[1]))
  });
}

async function probeStage(input: {
  readonly stage: ControlPlanePreflightStage;
  readonly pulledRefs: readonly string[];
  readonly incompletePullRef?: string;
  readonly operation: () => Promise<void>;
}): Promise<void> {
  try {
    await input.operation();
  } catch (error) {
    throw new ControlPlaneImageProbeError({
      kind: "preflight",
      stage: input.stage,
      pulledRefs: [...input.pulledRefs],
      ...(input.incompletePullRef === undefined ? {} : { incompletePullRef: input.incompletePullRef })
    }, error);
  }
}

async function pull(runner: ControlPlaneDockerRunner, image: string): Promise<void> {
  const result = await run(runner, ["pull", image], imageTimeout);
  if (result.exitCode !== 0) throw new ControlPlaneDockerError("failed to pull a control-plane image");
}

async function inspectImage(runner: ControlPlaneDockerRunner, probe: ImageProbe): Promise<void> {
  const result = await run(runner, [
    "image", "inspect", probe.image, "--format", "{{json .RepoDigests}}\n{{json .Config.User}}"
  ], probeTimeout);
  if (result.exitCode !== 0 || result.stderr !== "") throw new ControlPlaneDockerError("failed to inspect a control-plane image");
  const lines = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1).split("\n") : result.stdout.split("\n");
  if (lines.length !== 2) throw new ControlPlaneDockerError("control-plane image metadata is malformed");
  const digests = parseJson(lines[0]);
  const user = parseJson(lines[1]);
  if (!Array.isArray(digests) || !digests.every((entry) => typeof entry === "string") || !digests.includes(probe.image)) {
    throw new ControlPlaneDockerError("control-plane image digest could not be verified");
  }
  if (user !== probe.user) throw new ControlPlaneDockerError("control-plane image has the wrong numeric user");
}

async function runProbe(runner: ControlPlaneDockerRunner, args: readonly string[]): Promise<void> {
  const result = await run(runner, args, probeTimeout);
  if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") {
    throw new ControlPlaneDockerError("control-plane image configuration probe failed");
  }
}

function serviceProbeArgs(probe: ImageProbe): readonly string[] {
  return hardenedArgs({
    ...probe,
    mounts: [mount(probe.source, "/run/secrets/service.json")],
    command: ["check-config", "/run/secrets/service.json"]
  });
}

function bundleProbeArgs(nativeGit: ImageProbe, ordinaryCi: ImageProbe): readonly string[] {
  return hardenedArgs({
    ...nativeGit,
    mounts: [mount(nativeGit.source, "/run/native.json"), mount(ordinaryCi.source, "/run/ordinary.json")],
    command: ["check-bundle-config", "/run/native.json", "/run/ordinary.json"]
  });
}

function hardenedArgs(probe: HardenedProbe): readonly string[] {
  return [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", probe.user,
    ...probe.mounts.flatMap((value) => ["--mount", value]),
    "--entrypoint", serviceExecutable, probe.image, ...probe.command
  ];
}

function mount(source: string, destination: string): string {
  return `type=bind,src=${source},dst=${destination},readonly`;
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) throw new ControlPlaneDockerError("control-plane image metadata is malformed");
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneDockerError("control-plane image metadata is malformed", { cause: error });
    throw error;
  }
}

async function run(
  runner: ControlPlaneDockerRunner,
  args: readonly string[],
  timeoutMilliseconds: number
): Promise<ControlPlaneDockerCommandResult> {
  const result = await runner.run({ args, timeoutMilliseconds, maximumOutputBytes: outputLimit });
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) {
    throw new ControlPlaneDockerError("Docker image preflight output exceeded its limit");
  }
  return result;
}
