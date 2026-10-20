import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import path from "node:path";

async function optional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
async function atomic(file: string, contents: string, mode = 0o644): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export function mergeNpmRegistry(contents: string, registry: string): string {
  const base = contents.replace(/^# BEGIN DIM CACHE\r?\n[\s\S]*?^# END DIM CACHE(?:\r?\n|$)/gm, "");
  // User and project configuration retain precedence over this optional default.
  if (/^\s*(?:registry|["']registry["'])\s*=/im.test(base)) return base;
  return `${base}${base && !base.endsWith("\n") ? "\n" : ""}# BEGIN DIM CACHE\nregistry=${registry}/\n# END DIM CACHE\n`;
}
export async function configureNpmUserFile(file: string, registry: string): Promise<void> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error;
  });
  // Symlinks, non-owned files and other existing objects are explicit user policy.
  // Do not follow or replace them, and do not prevent other clients from starting.
  if (metadata && (!metadata.isFile() || metadata.uid !== process.getuid?.())) return;
  const previous = await optional(file) ?? "", next = mergeNpmRegistry(previous, registry);
  if (previous !== next) await atomic(file, next);
}
export function clientConfiguration(endpoint: string) {
  return { files: [{ target: "/etc/npmrc", contents: `registry=${endpoint.replace(/\/$/, "")}/\n` }],
    environmentDefaults: { NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc" } };
}
export async function configureUser(endpoint: string): Promise<void> {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("workspace home is unavailable");
  await configureNpmUserFile(path.join(home, ".npmrc"), endpoint.replace(/\/$/, ""));
}
export async function configureSystem(endpoint: string): Promise<void> {
  const file = "/etc/npmrc", previous = await optional(file) ?? "";
  const next = mergeNpmRegistry(previous, endpoint.replace(/\/$/, ""));
  if (previous !== next) await atomic(file, next);
}
export function removeNpmRegistry(contents: string, endpoint: string): string {
  const block = `# BEGIN DIM CACHE\nregistry=${endpoint.replace(/\/$/, "")}/\n# END DIM CACHE\n`;
  return contents.replace(block, "");
}
async function removeNpmFile(file: string, endpoint: string, user: boolean): Promise<void> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error;
  });
  if (!metadata?.isFile() || user && metadata.uid !== process.getuid?.()) return;
  const before = await optional(file);
  if (before === undefined) return;
  const next = removeNpmRegistry(before, endpoint);
  if (before !== next) await atomic(file, next, user ? 0o600 : 0o644);
}
export async function removeUser(endpoint: string): Promise<void> {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("workspace home is unavailable");
  await removeNpmFile(path.join(home, ".npmrc"), endpoint, true);
}
export async function removeSystem(endpoint: string): Promise<void> { await removeNpmFile("/etc/npmrc", endpoint, false); }
export function retiredClientConfiguration() { return { files: [{ target: "/etc/npmrc", contents: "# DIM cache default removed\n" }] }; }
