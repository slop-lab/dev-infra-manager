import { constants } from "node:fs";
import { access, lstat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { UserError, type AcquiredWorkspaceSource, type StreamingCommandRunner } from "@slop-lab/dim-core/workspace";
import { hostPluginHome } from "./host-plugins.js";

export interface RequiredPlugins {
  readonly status: "requires-plugins";
  readonly source: AcquiredWorkspaceSource;
  readonly plugins: readonly string[];
}

/** Repository declarations are data: only exact registry packages, never host paths or commands. */
export function exactPluginSpec(value: unknown): { name: string; version: string; spec: string } {
  if (typeof value !== "string" || value.length > 300) throw new UserError("workspace plugins must use exact registry PACKAGE@VERSION specs");
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value);
  if (!match || !match[1] || !match[2] || match[1].length > 214 || match[1].split("/").some((part) => part === "." || part === "..")) {
    throw new UserError(`workspace plugin '${value}' must use an exact registry PACKAGE@VERSION spec; paths, URLs and ranges are forbidden`);
  }
  return { name: match[1], version: match[2], spec: value };
}

export function pluginSpecs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new UserError("workspace plugins must be an array of at most 32 exact package specs");
  const names = new Set<string>();
  return value.map((item: unknown) => {
    const parsed = exactPluginSpec(item);
    if (names.has(parsed.name)) throw new UserError(`duplicate workspace plugin '${parsed.name}'`);
    names.add(parsed.name); return parsed.spec;
  });
}

async function declaredPlugins(directory: string): Promise<string[]> {
  const dim = path.join(directory, ".dim");
  try {
    const stat = await lstat(dim);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UserError("workspace .dim must be a real checkout directory");
  } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  let handle;
  try { handle = await open(path.join(dim, "workspace.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32_768) throw new UserError("workspace declaration must be a regular JSON file of at most 32 KiB");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!object(value) || Object.keys(value).some((key) => key !== "plugins")) throw new UserError("workspace declaration supports only 'plugins'");
    return pluginSpecs(value.plugins);
  } finally { await handle.close(); }
}

export async function missingPlugins(specs: readonly string[], home = hostPluginHome()): Promise<string[]> {
  if (!specs.length) return [];
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8")); }
  catch (error) { if (hasCode(error, "ENOENT")) return [...specs]; throw error; }
  if (!object(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.plugins)
    || !manifest.plugins.every((name: unknown) => typeof name === "string")) throw new UserError("invalid installed DIM plugin manifest");
  const enabled = new Set<unknown>(manifest.plugins);
  const missing: string[] = [];
  for (const spec of specs) {
    const { name, version } = exactPluginSpec(spec);
    if (!enabled.has(name)) { missing.push(spec); continue; }
    let metadata: unknown;
    try { metadata = JSON.parse(await readFile(path.join(home, "node_modules", ...name.split("/"), "package.json"), "utf8")); }
    catch (error) { if (hasCode(error, "ENOENT")) { missing.push(spec); continue; } throw error; }
    if (!object(metadata) || metadata.name !== name || metadata.version !== version) missing.push(spec);
  }
  return missing;
}

/** One create call, before a workspace record or runtime exists. No persisted preflight authority. */
export function workspaceRequirements(expectedCommit?: string) {
  if (expectedCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedCommit)) throw new UserError("invalid expected source commit");
  let missing: RequiredPlugins | undefined;
  return {
    get missing() { return missing; },
    async validateCheckout(directory: string, source: AcquiredWorkspaceSource) {
      if (expectedCommit !== undefined && source.commit !== expectedCommit) throw new UserError("source changed while plugin installation was approved; run create again to inspect its new requirements");
      const plugins = await missingPlugins(await declaredPlugins(directory));
      if (plugins.length) {
        missing = { status: "requires-plugins", source, plugins };
        throw new UserError(`workspace requires installed plugins: ${plugins.join(", ")}`);
      }
    }
  };
}

export async function installRequiredPlugins(specs: unknown, runner: StreamingCommandRunner, signal: AbortSignal): Promise<void> {
  const packages = pluginSpecs(specs);
  if (!packages.length) throw new UserError("no required plugins were selected");
  const args = ["exec", "--", "dim", "installer", "install", "plugin", ...packages];
  const facade = process.env.DIM_INSTALLER_ENTRYPOINT;
  if (facade !== undefined && !path.isAbsolute(facade)) throw new UserError("installer entrypoint must be an absolute host path");
  let mise = "mise";
  const localMise = path.join(homedir(), ".local/bin/mise");
  try { await access(localMise, constants.X_OK); mise = localMise; }
  catch (error) { if (!hasCode(error, "ENOENT") && !hasCode(error, "EACCES")) throw error; }
  const output = outputTail(), errors = outputTail();
  const exitCode = await runner.runStreaming(facade ? process.execPath : mise,
    facade ? [facade, "installer", "install", "plugin", ...packages] : args,
    { signal, stdin: Readable.from([]), stdout: output.stream, stderr: errors.stream });
  signal.throwIfAborted();
  if (exitCode !== 0) throw new UserError(`required plugin installation failed (exit ${exitCode}): ${errors.read() || output.read()}`);
  const missing = await missingPlugins(packages);
  if (missing.length) throw new UserError(`installer did not enable the requested exact plugins: ${missing.join(", ")}`);
}

function outputTail() {
  let tail = Buffer.alloc(0);
  return { stream: new Writable({ write(chunk: Buffer, _encoding, done) {
    tail = Buffer.concat([tail, chunk.subarray(-8192)]).subarray(-8192); done();
  } }), read: () => tail.toString("utf8") };
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
