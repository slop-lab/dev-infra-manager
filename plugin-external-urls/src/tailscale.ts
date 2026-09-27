import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UserError } from "@slop-lab/dim-core";

const run = promisify(execFile);
export const EXTERNAL_URL_INGRESS_DRIVER_EXTENSION = "external-url.ingress-driver";

export interface ExternalUrlIngressRuntime {
  readonly scheme: "tcp";
  readonly publicHost: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly upstreamMode: "container-ip";
}

export interface ExternalUrlIngressDriver {
  configure(scheme: "http" | "https" | "tcp", arguments_: readonly string[]): Promise<string>;
  runtime(argument: string): Promise<ExternalUrlIngressRuntime>;
  verify(argument: string): Promise<void>;
}

type TailscaleStatus = {
  readonly BackendState?: unknown;
  readonly Self?: { readonly TailscaleIPs?: unknown };
};

export const tailscaleIngressDriver: ExternalUrlIngressDriver = {
  async configure(scheme, arguments_) {
    if (scheme !== "tcp") throw new UserError("Tailscale ingress requires '--scheme tcp'");
    if (arguments_.length !== 2 || arguments_[0] !== "--listen-port") {
      throw new UserError("Tailscale ingress requires exactly '--listen-port PORT'");
    }
    const listenPort = Number(arguments_[1]);
    requireHighPort(listenPort);
    await currentTailscaleAddress();
    return JSON.stringify({ listenPort });
  },
  async runtime(argument) {
    const listenPort = parseArgument(argument);
    const address = await currentTailscaleAddress();
    return {
      scheme: "tcp",
      publicHost: address,
      listenHost: address,
      listenPort,
      upstreamMode: "container-ip"
    };
  },
  async verify(argument) {
    parseArgument(argument);
    await currentTailscaleAddress();
  }
};

export function tailscaleSelfAddress(value: TailscaleStatus): string {
  if (value.BackendState !== "Running") throw new UserError("Tailscale is not running on the DIM host");
  const addresses = value.Self?.TailscaleIPs;
  if (!Array.isArray(addresses)) throw new UserError("Tailscale status has no host self addresses");
  const address = addresses.find((candidate) => typeof candidate === "string" && isCgnatIpv4(candidate));
  if (typeof address !== "string") throw new UserError("Tailscale status has no allowed tailnet IPv4 address");
  return address;
}

async function currentTailscaleAddress(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    throw new UserError(`cannot read host Tailscale status: ${error instanceof Error ? error.message : String(error)}`);
  }
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    throw new UserError("host Tailscale status returned invalid JSON");
  }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new UserError("host Tailscale status returned an invalid object");
  }
  return tailscaleSelfAddress(status);
}

function parseArgument(argument: string): number {
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw new UserError("Tailscale ingress argument must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("listenPort" in value) || Object.keys(value).length !== 1) {
    throw new UserError("Tailscale ingress argument requires only 'listenPort'");
  }
  const listenPort = value.listenPort;
  requireHighPort(listenPort);
  return listenPort;
}

function requireHighPort(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 49_152 || value > 65_535) {
    throw new UserError("Tailscale ingress listen port must be an integer between 49152 and 65535");
  }
}

function isCgnatIpv4(value: string): boolean {
  const match = value.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  const second = octets[0];
  return second !== undefined && second >= 64 && second <= 127
    && octets.slice(1).every((octet) => octet >= 0 && octet <= 255);
}
