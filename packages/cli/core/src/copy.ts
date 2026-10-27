import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliHostProtocolError, createHostRequest, parseWorkspaceEndpoint } from "@slop-lab/dim-contracts-cli-host";
import type { HostTarget } from "./host-context.js";
import { callHost, HostTransportError, negotiateHost, streamHost } from "./host-transport.js";
import { createCopyArchive, stageCopyArchive, writeSingleFileArchive, type StagedCopyArchive } from "./copy-archive.js";

type CopyOperand = { readonly kind: "local"; readonly path: string } | { readonly kind: "workspace"; readonly name: string; readonly path: string };
type CopyRequest = { readonly source: CopyOperand; readonly destination: CopyOperand; readonly recursive: boolean; readonly overwrite: boolean };
type DownloadResult =
  | { readonly kind: "staged"; readonly archive: StagedCopyArchive }
  | { readonly kind: "written" }
  | { readonly kind: "failed"; readonly error: unknown; readonly early: boolean };

export const copyHelp = `Usage: dim cp [options] <source> <destination>

Copy between an operator-machine path and WORKSPACE:PATH.

Options:
  -r, --recursive  copy directories recursively
      --overwrite  replace an existing exact destination
  -h, --help       display this help

Exactly one operand must use WORKSPACE:PATH. Use -- before operands beginning with '-'.
The selected host owns workspace lookup and guest-path semantics.
`;

export async function copyWorkspace(target: HostTarget, args: readonly string[], signal: AbortSignal): Promise<number> {
  const request = parseCopyRequest(args);
  const remote = request.source.kind === "workspace" ? request.source : request.destination.kind === "workspace" ? request.destination : undefined;
  if (remote === undefined || request.source.kind === request.destination.kind) throw new CliHostProtocolError("cp requires exactly one WORKSPACE:PATH operand and one local path");
  if (request.source.kind === "local" && request.source.path !== "-") await localSource(request.source.path);
  await negotiateHost(target, { signal });
  const endpoint = parseWorkspaceEndpoint(await callHost(target, createHostRequest("workspace.endpoint", { name: remote.name }), { signal }));
  if (endpoint.runtimeStatus !== "running") throw new CliHostProtocolError(`workspace '${remote.name}' is ${endpoint.runtimeStatus}; run dim start ${remote.name}`);
  const command = ["cp", request.source.kind === "local" ? "-" : `${remote.name}:${remote.path}`,
    request.destination.kind === "local" ? "-" : `${remote.name}:${remote.path}`, "--expect-id", endpoint.workspaceId,
    ...(request.recursive ? ["--recursive"] : []), ...(request.overwrite ? ["--overwrite"] : [])];
  if (request.source.kind === "local") {
    let temporary: string | undefined;
    try {
      let source = request.source.path;
      if (source === "-") {
        temporary = await mkdtemp(path.join(tmpdir(), "dim-copy-stdin-"));
        source = path.join(temporary, "stdin");
        await pipeline(process.stdin, createWriteStream(source, { flags: "wx", mode: 0o600 }), { signal });
      }
      const archive = createCopyArchive(source, request.recursive, signal);
      return await streamHost(target, createHostRequest("command", { args: command, terminal: false }), { signal, terminal: false, stdin: archive, stderr: process.stderr });
    } finally { if (temporary !== undefined) await rm(temporary, { recursive: true, force: true }); }
  }
  const archive = new PassThrough();
  const transferAbort = new AbortController();
  const transferSignal = AbortSignal.any([signal, transferAbort.signal]);
  let status: number | undefined;
  let transportSettled = false;
  const extraction: Promise<DownloadResult> = (request.destination.path === "-"
    ? writeSingleFileArchive(archive, process.stdout, transferSignal).then(() => ({ kind: "written" }) as const)
    : stageCopyArchive(archive, request.destination.path, { overwrite: request.overwrite, signal: transferSignal })
      .then((staged) => ({ kind: "staged", archive: staged }) as const))
    .catch((error: unknown) => {
      const failed = { kind: "failed", error, early: !transportSettled } as const;
      archive.destroy(); transferAbort.abort(); return failed;
    });
  let transportError: unknown;
  try {
    status = await streamHost(target, createHostRequest("command", { args: command, terminal: false }), {
      signal: transferSignal, terminal: false, stdout: archive, stderr: process.stderr
    });
    transportSettled = true;
  } catch (error) { transportError = error; transportSettled = true; }
  finally { if (!archive.destroyed) archive.end(); }
  const downloaded = await extraction;
  if (downloaded.kind === "staged") {
    if (status === 0 && transportError === undefined) {
      try { await downloaded.archive.publish(); }
      catch (error) { await downloaded.archive.discard(); throw error; }
    } else await downloaded.archive.discard();
  }
  if (downloaded.kind === "failed" && !signal.aborted && (downloaded.early || status === 0)) throw downloaded.error;
  if (transportError !== undefined) throw transportError;
  if (status === undefined) throw new HostTransportError("host copy ended without a status");
  return status;
}

function parseCopyRequest(args: readonly string[]): CopyRequest {
  const operands: string[] = [];
  let recursive = false;
  let overwrite = false;
  let optionsEnded = false;
  for (const argument of args.slice(1)) {
    if (!optionsEnded && argument === "--") optionsEnded = true;
    else if (!optionsEnded && (argument === "-r" || argument === "--recursive")) recursive = true;
    else if (!optionsEnded && argument === "--overwrite") overwrite = true;
    else if (!optionsEnded && argument.startsWith("-") && argument !== "-") throw new CliHostProtocolError(`unknown cp option '${argument}'`);
    else operands.push(argument);
  }
  if (operands.length !== 2) throw new CliHostProtocolError("usage: dim cp [--recursive] [--overwrite] <source> <destination>");
  return { source: operand(operands[0] ?? ""), destination: operand(operands[1] ?? ""), recursive, overwrite };
}

function operand(value: string): CopyOperand {
  const match = /^([a-z0-9][a-z0-9_.-]{0,47}):(.*)$/.exec(value);
  if (match === null) return { kind: "local", path: value };
  if (!match[2] || match[2].includes("\0")) throw new CliHostProtocolError("workspace copy path must be nonempty");
  return { kind: "workspace", name: match[1] ?? "", path: match[2] };
}

async function localSource(source: string): Promise<void> {
  try {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new CliHostProtocolError("a copied symlink must be contained in a recursive directory source");
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new CliHostProtocolError(`local copy source '${source}' does not exist`);
    throw error;
  }
}
