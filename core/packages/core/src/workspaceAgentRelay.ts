import { isIP } from "node:net";
import { UserError } from "./errors.js";
import type { WorkspacePhase } from "./lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "./types.js";

const relayScript = "/usr/local/lib/dim/agent-git-relay.mjs";
const relayPort = 19_419;

type RelayAttestation = {
  readonly schemaVersion: 1;
  readonly status: "ready";
  readonly pid: number;
  readonly processStart: string;
  readonly configHash: string;
  readonly host: string;
  readonly port: number;
};

export async function startWorkspaceAgentRelay(
  runner: StreamingCommandRunner,
  network: string,
  containerId: string
): Promise<void> {
  const addressResult = await runner.run("docker", [
    "container", "inspect", containerId, "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`
  ]);
  const address = addressResult.stdout.trim();
  if (addressResult.exitCode !== 0 || isIP(address) === 0) {
    throw commandError("resolve trusted workspace relay address", addressResult);
  }
  const result = await runner.run("docker", [
    "exec",
    "--env", `DIM_AGENT_GIT_LISTEN_HOST=${address}`,
    "--env", "DIM_AGENT_GIT_INITIAL_PHASE=setting-up",
    containerId,
    "node", relayScript, "ensure"
  ]);
  if (result.exitCode !== 0) throw commandError("start trusted workspace relay", result);
  const attestation = parseAttestation(result.stdout);
  if (attestation.host !== address || attestation.port !== relayPort) {
    throw new UserError("trusted workspace relay readiness attestation does not match its configured listener");
  }
}

export async function notifyWorkspaceAgentRelayPhase(
  runner: StreamingCommandRunner,
  containerId: string,
  phase: WorkspacePhase
): Promise<void> {
  const result = await runner.run("docker", ["exec", containerId, "node", relayScript, "phase", phase]);
  if (result.exitCode !== 0) throw commandError(`publish trusted workspace relay phase '${phase}'`, result);
}

function parseAttestation(raw: string): RelayAttestation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new UserError("trusted workspace relay returned invalid readiness attestation");
  }
  const configHash = isRecord(value) && typeof value.configHash === "string" ? value.configHash : undefined;
  if (!isRecord(value) || Object.keys(value).length !== 7 || value.schemaVersion !== 1 || value.status !== "ready"
    || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || typeof value.processStart !== "string"
    || configHash === undefined || !/^[0-9a-f]{64}$/.test(configHash)
    || typeof value.host !== "string" || typeof value.port !== "number" || !Number.isSafeInteger(value.port)) {
    throw new UserError("trusted workspace relay returned invalid readiness attestation");
  }
  return {
    schemaVersion: 1,
    status: "ready",
    pid: value.pid,
    processStart: value.processStart,
    configHash,
    host: value.host,
    port: value.port
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandError(action: string, result: Pick<CommandResult, "stderr" | "stdout">): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
