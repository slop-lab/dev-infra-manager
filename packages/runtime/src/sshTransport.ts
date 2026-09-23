import { spawn } from "node:child_process";
import { once } from "node:events";
import { ProtocolError, TransportError } from "./errors.js";
import { parseScheduleProposal, type BrokerPollRequest, type ScheduleProposal } from "./protocol.js";

export type SshBrokerConfig = {
  readonly executable?: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
};

export class SshBrokerTransport {
  constructor(readonly config: SshBrokerConfig) {
    if (!/^[a-zA-Z0-9.-]+$/.test(config.host)) throw new ProtocolError("SSH broker host is invalid");
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.user)) throw new ProtocolError("SSH broker user is invalid");
    if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
      throw new ProtocolError("SSH broker port is invalid");
    }
    if (!config.identityFile.startsWith("/") || !config.knownHostsFile.startsWith("/")) {
      throw new ProtocolError("SSH identity and known-hosts files must use absolute local paths");
    }
  }

  async poll(request: BrokerPollRequest): Promise<ScheduleProposal> {
    const child = spawn(this.config.executable ?? "ssh", this.arguments(), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), this.config.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > this.config.maxResponseBytes) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify(request)}\n`);
    const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    clearTimeout(timer);
    if (stdoutBytes > this.config.maxResponseBytes) throw new TransportError("SSH broker response exceeded its byte limit");
    if (signal !== null) throw new TransportError(`SSH broker terminated by ${signal}`);
    if (exitCode !== 0) {
      throw new TransportError(`SSH broker exited ${String(exitCode)}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
    }
    const body = Buffer.concat(stdout).toString("utf8");
    try {
      return parseScheduleProposal(JSON.parse(body));
    } catch (error) {
      if (error instanceof ProtocolError || error instanceof SyntaxError) {
        throw new TransportError(`SSH broker returned an invalid protocol response: ${error.message}`);
      }
      throw error;
    }
  }

  private arguments(): readonly string[] {
    return [
      "-T",
      "-p", String(this.config.port),
      "-i", this.config.identityFile,
      "-o", "BatchMode=yes",
      "-o", "ClearAllForwardings=yes",
      "-o", "ForwardAgent=no",
      "-o", "PermitLocalCommand=no",
      "-o", "RequestTTY=no",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.config.knownHostsFile}`,
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil(this.config.timeoutMs / 1_000))}`,
      `${this.config.user}@${this.config.host}`,
      "dim-control-plane broker stdio"
    ];
  }
}
