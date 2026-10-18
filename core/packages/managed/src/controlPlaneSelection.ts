import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, UserError } from "@slop-lab/dim-core";
import { managedStateRoot } from "./lifecycleOptions.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { loadNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";

interface ControlPlaneSelection {
  readonly schemaVersion: 1;
  readonly hostConnectionFile: string;
  readonly importerConnectionFile: string;
}

function selectionFile(environment: NodeJS.ProcessEnv): string {
  return path.join(managedStateRoot(environment), "active-control-plane.json");
}

/** Persist host-owned references only after both private connections agree. */
export async function saveControlPlaneSelection(
  input: { hostConnectionFile: string; importerConnectionFile: string }, environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const hostConnectionFile = path.resolve(input.hostConnectionFile), importerConnectionFile = path.resolve(input.importerConnectionFile);
  const host = await loadNativeControlPlaneConnection(hostConnectionFile);
  const importer = await loadNativeGitRootImporterConnection(importerConnectionFile);
  if (host.hostId !== importer.hostId || host.nativeGit.endpoint !== importer.endpoint
    || host.nativeGit.generationId !== importer.generationId || host.nativeGit.serviceId !== importer.serviceId) {
    throw new UserError("host and root importer connections do not select the same control plane and generation");
  }
  await atomicWrite(selectionFile(environment), { schemaVersion: 1, hostConnectionFile, importerConnectionFile });
}

export async function selectedControlPlaneHostFile(environment: NodeJS.ProcessEnv = process.env, fallback?: string): Promise<string> {
  return selectFile("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", "hostConnectionFile", environment, fallback);
}
export async function selectedControlPlaneImporterFile(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return selectFile("DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE", "importerConnectionFile", environment);
}
async function selectFile(key: string, field: "hostConnectionFile" | "importerConnectionFile", environment: NodeJS.ProcessEnv, fallback?: string): Promise<string> {
  const override = environment[key];
  if (override !== undefined) {
    if (!override) throw new UserError(`${key} must not be empty`);
    return path.resolve(override);
  }
  const selected = await readSelection(environment);
  if (!selected && fallback !== undefined) return fallback;
  if (!selected) throw new UserError("no native control plane selected on this host; run 'dim managed control-plane connect SETUP'");
  return selected[field];
}
async function readSelection(environment: NodeJS.ProcessEnv): Promise<ControlPlaneSelection | undefined> {
  let handle;
  try { handle = await open(selectionFile(environment), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600
      || metadata.nlink !== 1 || metadata.size > 16 * 1024) throw new UserError("active control-plane selection must be a private regular file");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("active control-plane selection is invalid");
    const selected = value as Record<string, unknown>;
    if (Object.keys(selected).length !== 3 || selected.schemaVersion !== 1
      || typeof selected.hostConnectionFile !== "string" || !path.isAbsolute(selected.hostConnectionFile)
      || typeof selected.importerConnectionFile !== "string" || !path.isAbsolute(selected.importerConnectionFile)) throw new UserError("active control-plane selection is invalid");
    return { schemaVersion: 1, hostConnectionFile: selected.hostConnectionFile, importerConnectionFile: selected.importerConnectionFile };
  } finally { await handle.close(); }
}
