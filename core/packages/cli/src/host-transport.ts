import { spawn } from "node:child_process";
import { type HostTarget, validateTarget } from "./host-context.js";

export interface HostRequest {
  readonly operation: string;
  readonly input?: Record<string, unknown>;
}

export interface HostTransportOptions {
  /** Override for an embedded client or a test host, without invoking a shell. */
  readonly localCommand?: { readonly file: string; readonly args?: readonly string[] };
  readonly sshExecutable?: string;
  readonly terminal?: boolean;
  readonly signal?: AbortSignal;
  readonly stderr?: NodeJS.WritableStream;
}

export class HostTransportError extends Error {
  readonly reported: boolean;

  constructor(message: string, readonly exitCode = 1, options?: ErrorOptions & { reported?: boolean }) {
    super(message, options);
    this.reported = options?.reported ?? false;
  }
}

export function encodeHostRequest(request: HostRequest): string {
  validateRequest(request);
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeHostRequest(encoded: string): HostRequest {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid request encoding");
    const request: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    validateRequest(request);
    return request;
  } catch (error) {
    throw new HostTransportError("invalid host request", 2, { cause: error });
  }
}

export function hostInvocation(
  target: HostTarget,
  request: HostRequest,
  options: HostTransportOptions = {}
): { file: string; args: string[] } {
  validateTarget(target);
  const encoded = encodeHostRequest(request);
  if (target.ssh !== undefined) {
    // OpenSSH joins remote argv for a remote shell. Only fixed tokens and the
    // base64url payload enter that command; user input never becomes shell code.
    return {
      file: options.sshExecutable ?? "ssh",
      args: [options.terminal ? "-tt" : "-T", "--", target.ssh, remoteHostCommand(encoded)]
    };
  }
  const local = options.localCommand ?? {
    file: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? ""]
  };
  if (!local.file || local.args?.some((argument) => argument.length === 0)) {
    throw new HostTransportError("cannot locate the local DIM host entrypoint");
  }
  return { file: local.file, args: [...(local.args ?? []), "__host", encoded] };
}

function remoteHostCommand(encoded: string): string {
  // SSH normally starts a non-interactive shell, without mise's activated PATH.
  // Keep this bootstrap fixed; only the encoded request varies between calls.
  const arguments_ = `__host ${encoded}`;
  return `if command -v dim >/dev/null 2>&1; then exec dim ${arguments_}; `
    + `elif command -v mise >/dev/null 2>&1; then exec mise exec -- dim ${arguments_}; `
    + `elif [ -x "$HOME/.local/bin/mise" ]; then exec "$HOME/.local/bin/mise" exec -- dim ${arguments_}; `
    + `else printf '%s\\n' 'DIM was not found on this SSH host. Install @slop-lab/dim-installer with mise and run dim installer install core.' >&2; exit 127; fi`;
}

/** Record operations reserve stdout for exactly one JSON result. */
export async function callHost<T = unknown>(
  target: HostTarget,
  request: HostRequest,
  options: HostTransportOptions = {}
): Promise<T> {
  const invocation = hostInvocation(target, request, { ...options, terminal: false });
  const child = spawn(invocation.file, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    (options.stderr ?? process.stderr).write(chunk);
  });
  const exitCode = await processExit(child, target);
  if (exitCode !== 0) {
    throw new HostTransportError(stderr.trim() || `host '${target.name}' command failed (${exitCode})`, exitCode, {
      reported: stderr.trim().length > 0
    });
  }
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new HostTransportError(`host '${target.name}' returned an invalid JSON result`, 1, { cause: error });
  }
}

/** Exec leaves stdin and terminal byte streams intact and returns the remote status. */
export async function streamHost(
  target: HostTarget,
  request: HostRequest,
  options: HostTransportOptions = {}
): Promise<number> {
  const invocation = hostInvocation(target, request, options);
  const child = spawn(invocation.file, invocation.args, {
    stdio: "inherit",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return processExit(child, target);
}

function processExit(child: ReturnType<typeof spawn>, target: HostTarget): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new HostTransportError(
      `could not run command on host '${target.name}': ${error.message}`, 1, { cause: error }
    )));
    child.once("close", (code, signal) => {
      if (signal) reject(new HostTransportError(`host '${target.name}' command terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function validateRequest(value: unknown): asserts value is HostRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("operation" in value) || typeof value.operation !== "string"
    || !/^[a-z][a-zA-Z0-9.]*$/.test(value.operation)
    || ("input" in value && (value.input === null || typeof value.input !== "object" || Array.isArray(value.input)))) {
    throw new HostTransportError("invalid host request", 2);
  }
}
