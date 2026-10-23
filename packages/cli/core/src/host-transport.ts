import { encodeHostRequest, type HostRequest } from "@slop-lab/dim-host-core/application/protocol";
import { spawn } from "node:child_process";
import { type Readable, type Writable } from "node:stream";
import { type HostTarget, validateTarget } from "./host-context.js";

export interface HostTransportOptions {
  /** Override for an embedded client or a test host, without invoking a shell. */
  readonly localCommand?: { readonly file: string; readonly args?: readonly string[] };
  readonly sshExecutable?: string;
  readonly terminal?: boolean;
  readonly signal?: AbortSignal;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: NodeJS.WritableStream;
  /** Optional combined stdout/stderr bound for record operations. */
  readonly maxOutputBytes?: number;
}

export class HostTransportError extends Error {
  readonly reported: boolean;

  constructor(message: string, readonly exitCode = 1, options?: ErrorOptions & { reported?: boolean }) {
    super(message, options);
    this.reported = options?.reported ?? false;
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
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) throw new HostTransportError("invalid host response size limit");
  const invocation = hostInvocation(target, request, { ...options, terminal: false });
  const child = spawn(invocation.file, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let outputError: HostTransportError | undefined;
  const accept = (chunk: string) => {
    if (outputError) return false;
    bytes += Buffer.byteLength(chunk, "utf8");
    if (options.maxOutputBytes !== undefined && bytes > options.maxOutputBytes) {
      outputError = new HostTransportError(`host '${target.name}' response exceeded its size limit`);
      child.kill("SIGKILL"); return false;
    }
    return true;
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (accept(chunk)) stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (!accept(chunk)) return;
    stderr += chunk;
    (options.stderr ?? process.stderr).write(chunk);
  });
  let exitCode: number;
  try { exitCode = await processExit(child, target); }
  catch (error) { throw outputError ?? error; }
  if (outputError) throw outputError;
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
  if (options.signal?.aborted) throw new HostTransportError("host connection cancelled", 130);
  if (options.terminal && (options.stdin || options.stdout)) {
    throw new HostTransportError("custom byte streams cannot use a terminal", 2);
  }
  const invocation = hostInvocation(target, request, options);
  const child = spawn(invocation.file, invocation.args, {
    stdio: [options.stdin ? "pipe" : "inherit", options.stdout ? "pipe" : "inherit", options.stderr ? "pipe" : "inherit"]
  });
  const streamAbort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, streamAbort.signal]) : streamAbort.signal;
  const failedStream = () => streamAbort.abort();
  const unpipeInput = () => {
    if (child.stdin) options.stdin?.unpipe(child.stdin);
  };
  options.stdin?.once("error", failedStream);
  options.stdout?.once("error", failedStream);
  options.stderr?.once("error", failedStream);
  if (child.stdin && options.stdin) {
    child.stdin.once("error", unpipeInput);
    options.stdin.pipe(child.stdin);
  }
  if (child.stdout && options.stdout) child.stdout.pipe(options.stdout);
  if (child.stderr && options.stderr) child.stderr.pipe(options.stderr, { end: false });
  try {
    return await processExit(child, target, signal);
  } finally {
    unpipeInput();
    options.stdin?.pause();
    options.stdin?.off("error", failedStream);
    options.stdout?.off("error", failedStream);
    options.stderr?.off("error", failedStream);
    if (options.stdout) child.stdout?.unpipe(options.stdout);
    if (options.stderr) child.stderr?.unpipe(options.stderr);
  }
}

function processExit(child: ReturnType<typeof spawn>, target: HostTarget, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminating = false;
    const abort = () => {
      if (terminating) return;
      terminating = true;
      child.kill("SIGTERM");
      // The host may need its bounded three-second container exec cleanup.
      timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", (error) => {
      cleanup();
      reject(new HostTransportError(`could not run command on host '${target.name}': ${error.message}`, 1, { cause: error }));
    });
    child.once("close", (code, terminatedBy) => {
      cleanup();
      if (terminatedBy) reject(new HostTransportError(`host '${target.name}' command terminated by ${terminatedBy}`));
      else resolve(code ?? 1);
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
