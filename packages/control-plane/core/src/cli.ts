#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startControlPlanePlugins, type ControlPlanePluginEntry } from "./runtime.js";
import type { ControlPlanePlugin, RunningControlPlanePlugin } from "./plugin.js";

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export async function startControlPlaneFile(path: string, signal: AbortSignal, environment: NodeJS.ProcessEnv = process.env): Promise<RunningControlPlanePlugin> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let manifest: unknown;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o077) !== 0 || metadata.nlink !== 1 || metadata.size > 1024 * 1024) {
      throw new Error("control-plane configuration must be a private user-owned regular file of at most 1 MiB");
    }
    manifest = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  if (!object(manifest) || manifest.schemaVersion !== 1 || Object.keys(manifest).some((key) => !["schemaVersion", "plugins"].includes(key))
    || !Array.isArray(manifest.plugins) || manifest.plugins.length > 32) throw new Error("invalid control-plane configuration");
  const home = resolve(environment.DIM_CONTROL_PLANE_PLUGIN_HOME ?? join(environment.DIM_DATA_HOME
    ?? join(environment.XDG_DATA_HOME ?? join(environment.HOME ?? homedir(), ".local", "share"), "dim"), "control-plane", "runtime", "current"));
  let enabled: readonly string[] = [];
  if (manifest.plugins.length) {
    let installed: unknown;
    try { installed = JSON.parse(await readFile(join(home, "plugins.json"), "utf8")); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (installed !== undefined) {
      if (!object(installed) || installed.schemaVersion !== 1 || !Array.isArray(installed.plugins)
        || !installed.plugins.every((name: unknown): name is string => typeof name === "string")) throw new Error("invalid installed control-plane plugin manifest");
      enabled = installed.plugins;
    }
  }
  const selected: { package: string; config: unknown }[] = [];
  for (const entry of manifest.plugins) {
    if (!object(entry) || typeof entry.package !== "string" || !/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(entry.package)
      || !Object.hasOwn(entry, "config") || Object.keys(entry).some((key) => !["package", "config"].includes(key))) {
      throw new Error("control-plane plugins must select explicitly installed scoped packages and configuration");
    }
    if (!enabled.includes(entry.package)) throw new Error(`control-plane plugin '${entry.package}' is not enabled in ${home}`);
    selected.push({ package: entry.package, config: entry.config });
  }
  const entries: ControlPlanePluginEntry[] = [];
  const installed = createRequire(join(home, "package.json"));
  for (const entry of selected) {
    signal.throwIfAborted();
    let packageDirectory: string;
    try { packageDirectory = await realpath(join(home, "node_modules", entry.package)); }
    catch (error) { throw new Error(`control-plane plugin '${entry.package}' is not installed in ${home}`, { cause: error }); }
    const entryPath = await realpath(installed.resolve(entry.package));
    const packageRelative = relative(packageDirectory, entryPath);
    if (packageRelative === ".." || packageRelative.startsWith("../") || isAbsolute(packageRelative)) {
      throw new Error(`control-plane plugin '${entry.package}' resolves outside its installed package`);
    }
    const module: unknown = await import(pathToFileURL(entryPath).href);
    if (!object(module) || !object(module.controlPlanePlugin) || module.controlPlanePlugin.apiVersion !== 1
      || typeof module.controlPlanePlugin.name !== "string" || typeof module.controlPlanePlugin.configure !== "function") {
      throw new Error(`${entry.package} does not export a controlPlanePlugin`);
    }
    entries.push({ plugin: module.controlPlanePlugin as ControlPlanePlugin, config: entry.config });
  }
  return startControlPlanePlugins(entries, signal);
}

export async function runControlPlaneCli(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "run" || !args[1]) throw new Error("usage: dim-control-plane run FILE");
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let service: RunningControlPlanePlugin | undefined;
  try {
    service = await startControlPlaneFile(args[1], shutdown.signal);
    if (!shutdown.signal.aborted) await new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
    await service?.close();
  }
}
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  runControlPlaneCli(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
