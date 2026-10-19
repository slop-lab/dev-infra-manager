import { ControlPlaneDockerError, type ControlPlaneDockerRunner } from "./controlPlaneDockerTypes.js";

const outputLimit = 64 * 1024;
const probeTimeout = 30_000;
const executable = "/usr/local/bin/dim-service";

type ServiceProbe = {
  readonly service: "native-git" | "ordinary-ci";
  readonly user: "10001:10001" | "10002:10002";
  readonly volume: string;
  readonly statePath: string;
  readonly candidateImage: string;
  readonly priorImage: string;
};

type Compatibility = {
  readonly writeFormat: number;
  readonly readableFormats: readonly number[];
};

export async function probeControlPlaneUpdate(
  runner: ControlPlaneDockerRunner,
  images: {
    readonly nativeGit: { readonly candidate: string; readonly prior: string };
    readonly ordinaryCi: { readonly candidate: string; readonly prior: string };
  }
): Promise<void> {
  const probes = [
    {
      service: "native-git", user: "10001:10001", volume: "dim-control-plane-native-git-data",
      statePath: "/var/lib/dim-native-git", candidateImage: images.nativeGit.candidate, priorImage: images.nativeGit.prior
    },
    {
      service: "ordinary-ci", user: "10002:10002", volume: "dim-control-plane-ordinary-ci-data",
      statePath: "/var/lib/dim-ordinary-ci", candidateImage: images.ordinaryCi.candidate, priorImage: images.ordinaryCi.prior
    }
  ] as const satisfies readonly ServiceProbe[];
  for (const probe of probes) await probeService(runner, probe);
}

async function probeService(runner: ControlPlaneDockerRunner, probe: ServiceProbe): Promise<void> {
  const candidateCompatibility = await compatibility(runner, probe, probe.candidateImage);
  const priorCompatibility = await compatibility(runner, probe, probe.priorImage);
  const candidateState = await stateFormat(runner, probe, probe.candidateImage);
  const priorState = await stateFormat(runner, probe, probe.priorImage);
  if (candidateState !== priorState
    || !candidateCompatibility.readableFormats.includes(candidateState)
    || !priorCompatibility.readableFormats.includes(candidateState)
    || !priorCompatibility.readableFormats.includes(candidateCompatibility.writeFormat)
    || !candidateCompatibility.readableFormats.includes(priorCompatibility.writeFormat)) {
    throw new ControlPlaneDockerError("control-plane image and state formats are not bidirectionally compatible");
  }
}

async function compatibility(
  runner: ControlPlaneDockerRunner,
  probe: ServiceProbe,
  image: string
): Promise<Compatibility> {
  const result = await run(runner, hardened({ probe, image, command: ["compatibility", "--json"], mounts: [] }));
  const value = exactRecord(result, ["schemaVersion", "writeFormat", "readableFormats"]);
  if (value.schemaVersion !== 1 || !positiveInteger(value.writeFormat) || !Array.isArray(value.readableFormats)
    || value.readableFormats.length === 0 || !value.readableFormats.every(positiveInteger)
    || !strictlyAscending(value.readableFormats)) {
    throw new ControlPlaneDockerError("control-plane image compatibility response is invalid");
  }
  return { writeFormat: value.writeFormat, readableFormats: value.readableFormats };
}

async function stateFormat(runner: ControlPlaneDockerRunner, probe: ServiceProbe, image: string): Promise<number> {
  const mounts = [`type=volume,src=${probe.volume},dst=${probe.statePath},readonly`];
  const result = await run(runner, hardened({
    probe, image, command: ["check-state", "--read-only", probe.statePath, "--json"], mounts
  }));
  const value = exactRecord(result, ["schemaVersion", "stateFormat"]);
  if (value.schemaVersion !== 1 || !positiveInteger(value.stateFormat)) {
    throw new ControlPlaneDockerError("control-plane state probe response is invalid");
  }
  return value.stateFormat;
}

function hardened(input: {
  readonly probe: ServiceProbe;
  readonly image: string;
  readonly command: readonly string[];
  readonly mounts: readonly string[];
}): readonly string[] {
  return [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", input.probe.user,
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777",
    ...input.mounts.flatMap((mount) => ["--mount", mount]),
    "--entrypoint", executable, input.image, ...input.command
  ];
}

async function run(runner: ControlPlaneDockerRunner, args: readonly string[]): Promise<string> {
  const result = await runner.run({ args, timeoutMilliseconds: probeTimeout, maximumOutputBytes: outputLimit });
  if (result.exitCode !== 0 || result.stderr !== "" || !result.stdout.endsWith("\n")
    || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) {
    throw new ControlPlaneDockerError("control-plane update probe failed");
  }
  return result.stdout.slice(0, -1);
}

function exactRecord(value: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneDockerError("control-plane update probe returned malformed JSON", { cause: error });
    throw error;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== keys.length || keys.some((key) => !Object.hasOwn(parsed, key))) {
    throw new ControlPlaneDockerError("control-plane update probe response is not exact");
  }
  return parsed;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function strictlyAscending(values: readonly number[]): boolean {
  return values.every((entry, index) => index === 0 || entry > (values[index - 1] ?? entry));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
