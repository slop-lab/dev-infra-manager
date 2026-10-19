export type ControlPlanePreflightStage =
  | "native-git image pull"
  | "ordinary-ci image pull"
  | "native-git image verification"
  | "ordinary-ci image verification"
  | "native-git configuration"
  | "ordinary-ci configuration"
  | "bundle configuration";

export type ControlPlaneFailureCode =
  | "readiness-failed"
  | "service-replacement-failed"
  | "runtime-validation-failed"
  | "docker-command-failed"
  | "state-operation-failed"
  | "install-operation-failed"
  | "unexpected-failure";

export type ControlPlaneInstallErrorDetails =
  | {
    readonly kind: "preflight";
    readonly stage: ControlPlanePreflightStage;
    readonly pulledRefs: readonly string[];
    readonly incompletePullRef?: string;
  }
  | {
    readonly kind: "rollback";
    readonly originalCode: ControlPlaneFailureCode;
    readonly rollbackCode: ControlPlaneFailureCode;
    readonly priorGeneration: string;
    readonly candidateGeneration: string;
    readonly volumes: readonly string[];
  };

type ControlPlaneInstallErrorOptions = ErrorOptions & {
  readonly code?: ControlPlaneFailureCode;
  readonly details?: ControlPlaneInstallErrorDetails;
};

export class ControlPlaneInstallError extends Error {
  readonly name = "ControlPlaneInstallError";
  readonly code: ControlPlaneFailureCode;
  readonly details: ControlPlaneInstallErrorDetails | undefined;

  constructor(message: string, options: ControlPlaneInstallErrorOptions = {}) {
    super(message, options);
    this.code = options.code ?? "install-operation-failed";
    this.details = options.details;
  }
}

export class ControlPlaneImageProbeError extends ControlPlaneDockerError {
  constructor(readonly details: Extract<ControlPlaneInstallErrorDetails, { readonly kind: "preflight" }>, cause: unknown) {
    super("control-plane image preflight failed", { cause });
  }
}

export function controlPlaneFailureCode(error: unknown): ControlPlaneFailureCode {
  if (error instanceof ControlPlaneInstallError) return error.code;
  if (!(error instanceof Error)) return "unexpected-failure";
  switch (error.name) {
    case "ControlPlaneServiceUpdateError": return "service-replacement-failed";
    case "ControlPlaneRuntimeError": return "runtime-validation-failed";
    case "ControlPlaneDockerError":
    case "ControlPlaneDockerExecutionError":
    case "ControlPlaneDockerUncertainError": return "docker-command-failed";
    case "ControlPlaneGenerationError":
    case "ControlPlaneJournalError":
    case "ControlPlaneStateError":
    case "ControlPlaneStateFilesystemError": return "state-operation-failed";
    default: return "unexpected-failure";
  }
}

export function controlPlaneFailureDescription(code: ControlPlaneFailureCode): string {
  switch (code) {
    case "readiness-failed": return "service readiness failure";
    case "service-replacement-failed": return "service replacement failure";
    case "runtime-validation-failed": return "runtime validation failure";
    case "docker-command-failed": return "Docker command failure";
    case "state-operation-failed": return "state operation failure";
    case "install-operation-failed": return "installation operation failure";
    case "unexpected-failure": return "unexpected internal failure";
    default: return assertNever(code);
  }
}

export function controlPlaneRollbackFailure(input: {
  readonly original: unknown;
  readonly rollback: unknown;
  readonly priorGeneration: string;
  readonly candidateGeneration: string;
}): ControlPlaneInstallError {
  const originalCode = controlPlaneFailureCode(input.original);
  const rollbackCode = controlPlaneFailureCode(input.rollback);
  return new ControlPlaneInstallError(
    `control-plane update and rollback failed: original ${controlPlaneFailureDescription(originalCode)}; rollback ${controlPlaneFailureDescription(rollbackCode)}; recovery evidence and data volumes were retained`,
    {
      cause: new AggregateError([input.original, input.rollback]),
      details: {
        kind: "rollback",
        originalCode,
        rollbackCode,
        priorGeneration: input.priorGeneration,
        candidateGeneration: input.candidateGeneration,
        volumes: ["dim-control-plane-native-git-data", "dim-control-plane-ordinary-ci-data"]
      }
    }
  );
}

export function formatControlPlaneInstallError(error: ControlPlaneInstallError): readonly string[] {
  const details = error.details;
  if (details === undefined) return [error.message];
  switch (details.kind) {
    case "preflight": return [
      error.message,
      `preflight stage: ${details.stage}`,
      ...details.pulledRefs.map((reference) => `pulled image may remain cached: ${reference}`),
      ...(details.incompletePullRef === undefined
        ? []
        : [`failed pull may have left a partial cache entry: ${details.incompletePullRef}`])
    ];
    case "rollback": return [
      error.message,
      `original failure: ${controlPlaneFailureDescription(details.originalCode)}`,
      `rollback failure: ${controlPlaneFailureDescription(details.rollbackCode)}`,
      `retained prior generation: ${details.priorGeneration}`,
      `retained candidate generation: ${details.candidateGeneration}`,
      ...details.volumes.map((volume) => `retained data volume: ${volume}`)
    ];
    default: return assertNever(details);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unhandled control-plane installer variant: ${String(value)}`);
}
import { ControlPlaneDockerError } from "./controlPlaneDockerTypes.js";
