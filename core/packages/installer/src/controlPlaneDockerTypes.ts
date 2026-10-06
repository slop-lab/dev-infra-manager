import type { ControlPlaneConfig } from "./controlPlaneConfig.js";

export type ControlPlaneDockerCommand = {
  readonly args: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
};

export type ControlPlaneDockerCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface ControlPlaneDockerRunner {
  run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult>;
}

export type ControlPlaneProbeSnapshots = {
  readonly nativeGit: string;
  readonly ordinaryCi: string;
};

export type ControlPlaneDockerPreflightInput = {
  readonly config: ControlPlaneConfig;
  readonly snapshots: ControlPlaneProbeSnapshots;
};

export type ControlPlaneDockerState =
  | { readonly kind: "absent" }
  | { readonly kind: "owned"; readonly nativeGitContainerId: string; readonly ordinaryCiContainerId: string };

export class ControlPlaneDockerError extends Error {
  readonly name = "ControlPlaneDockerError";
}

export class ControlPlaneDockerExecutionError extends Error {
  readonly name: string = "ControlPlaneDockerExecutionError";
}

export class ControlPlaneDockerUncertainError extends ControlPlaneDockerExecutionError {
  readonly name = "ControlPlaneDockerUncertainError";
}
