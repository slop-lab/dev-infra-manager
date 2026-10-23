import { createServer, type Socket } from "node:net";
import { CliHostProtocolError, createHostRequest, parseWorkspaceEndpoint } from "@slop-lab/dim-contracts-cli-host";
import { type HostTarget } from "./host-context.js";
import { callHost, negotiateHost, streamHost, type HostTransportOptions } from "./host-transport.js";

export interface ForwardOptions extends HostTransportOptions {
  readonly onListening?: (port: number) => void;
}

/** Each accepted client gets an authenticated host stream pinned to one workspace. */
export async function forwardWorkspace(
  target: HostTarget,
  name: string,
  localPort: number,
  remotePort: number,
  options: ForwardOptions = {}
): Promise<void> {
  await negotiateHost(target, options);
  const record = parseWorkspaceEndpoint(await callHost(target, createHostRequest("workspace.endpoint", { name }), options));
  if (record.runtimeStatus !== "running") throw new CliHostProtocolError(`workspace '${name}' is ${record.runtimeStatus}; run dim start ${name}`);
  options.signal?.throwIfAborted();
  const sessions = new Set<{ socket: Socket; abort: AbortController; done: Promise<void> }>();
  let stopping = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (stopping) { socket.destroy(); return; }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    socket.once("error", cancel);
    socket.once("close", cancel);
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const session = { socket, abort, done: Promise.resolve() };
    sessions.add(session);
    session.done = streamHost(target, createHostRequest("workspace.connect", { name, port: remotePort, workspaceId: record.workspaceId }), { ...options, terminal: false, stdin: socket, stdout: socket, signal }).then((exitCode) => {
      if (exitCode !== 0 && !signal.aborted) throw new Error(`host connection exited with status ${exitCode}`);
      if (!socket.destroyed) socket.end(() => socket.destroy());
    }).catch((error: unknown) => {
      if (!signal.aborted) (options.stderr ?? process.stderr).write(
        `Forward '${target.name}/${name}:${remotePort}': ${error instanceof Error ? error.message : String(error)}\n`
      );
      socket.destroy();
    }).finally(() => {
      sessions.delete(session);
      socket.off("error", cancel);
      socket.off("close", cancel);
    });
  });
  let stop: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => { server.off("listening", listening); reject(cause); };
      const listening = () => { server.off("error", error); resolve(); };
      server.once("error", error);
      server.once("listening", listening);
      server.listen(localPort, "127.0.0.1");
    });
    const stopped = new Promise<void>((resolve, reject) => {
      stop = resolve;
      failed = reject;
      options.signal?.addEventListener("abort", stop, { once: true });
      server.once("error", failed);
      if (options.signal?.aborted) resolve();
    });
    const address = server.address();
    if (address && typeof address === "object") options.onListening?.(address.port);
    await stopped;
  } finally {
    stopping = true;
    if (stop) options.signal?.removeEventListener("abort", stop);
    if (failed) server.off("error", failed);
    const closed = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    const active = [...sessions];
    for (const session of active) { session.abort.abort(); session.socket.destroy(); }
    await Promise.allSettled(active.map((session) => session.done));
    await closed;
  }
}
