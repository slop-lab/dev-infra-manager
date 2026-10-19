import type { ControlPlaneConfig, ControlPlanePublish } from "./controlPlaneConfig.js";
import { ControlPlaneDockerError, type ControlPlaneDockerRunner } from "./controlPlaneDockerTypes.js";

const outputLimit = 4 * 1024;
const probeTimeout = 30_000;
const containerPort = 8080;
const exitCommand = "process.exit(0)";

type PriorPublications = {
  readonly nativeGit: ControlPlanePublish;
  readonly ordinaryCi: ControlPlanePublish;
};

type PublicationProbe = {
  readonly service: "native-git" | "ordinary-ci";
  readonly image: string;
  readonly user: "10001:10001" | "10002:10002";
  readonly publish: ControlPlanePublish;
  readonly prior: ControlPlanePublish | undefined;
};

export async function probeControlPlanePublishedAddresses(
  runner: ControlPlaneDockerRunner,
  config: ControlPlaneConfig,
  prior: PriorPublications | undefined
): Promise<void> {
  const probes = [
    {
      service: "native-git",
      image: config.nativeGit.image,
      user: "10001:10001",
      publish: config.nativeGit.publish,
      prior: prior?.nativeGit
    },
    {
      service: "ordinary-ci",
      image: config.ordinaryCi.image,
      user: "10002:10002",
      publish: config.ordinaryCi.publish,
      prior: prior?.ordinaryCi
    }
  ] as const satisfies readonly PublicationProbe[];

  for (const probe of probes) {
    if (samePublication(probe.publish, probe.prior)) continue;
    const result = await runner.run({
      args: [
        "run", "--rm", "--pull", "never", "--network", "bridge",
        "--publish", publicationArgument(probe.publish),
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--user", probe.user, "--entrypoint", "node", probe.image,
        "--input-type=module", "--eval", exitCommand
      ],
      timeoutMilliseconds: probeTimeout,
      maximumOutputBytes: outputLimit
    });
    if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw new ControlPlaneDockerError(`control-plane ${probe.service} published address is unavailable`);
    }
  }
}

function samePublication(candidate: ControlPlanePublish, prior: ControlPlanePublish | undefined): boolean {
  return prior !== undefined && candidate.host === prior.host && candidate.port === prior.port;
}

function publicationArgument(publish: ControlPlanePublish): string {
  const host = publish.host.includes(":") ? `[${publish.host}]` : publish.host;
  return `${host}:${publish.port}:${containerPort}`;
}
