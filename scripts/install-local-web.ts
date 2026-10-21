import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid local Web package manifest");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("invalid local Web package manifest string");
  return value;
}
interface Artifact { name: string; version: string; file: string; requires: Record<string, string> }
/** Include the optional operator clients without installing them into the host runtime. */
export function webArtifacts(manifest: unknown): Artifact[] {
  const value = object(manifest);
  if (value.schemaVersion !== 1 || !Array.isArray(value.packages)) throw new Error("invalid local Web package manifest");
  const records = value.packages.map((input) => {
    const entry = object(input), file = text(entry.file);
    if (basename(file) !== file || !file.endsWith(".tgz")) throw new Error("unsafe local Web package artifact path");
    return { name: text(entry.name), version: text(entry.version), file,
      requires: Object.fromEntries(Object.entries(object(entry.requires ?? {})).map(([name, version]) => [name, text(version)])) };
  });
  const catalog = new Map(records.map((entry) => [entry.name, entry]));
  if (catalog.size !== records.length) throw new Error("duplicate local package name");
  const version = catalog.get("@slop-lab/dim-cli")?.version;
  if (!version) throw new Error("local Web bundle lacks matching CLI version");
  const selected = new Map<string, Artifact>();
  function include(name: string, expected = version): void {
    const entry = catalog.get(name);
    if (!entry || entry.version !== expected || entry.version !== version) throw new Error(`local Web bundle lacks matching ${name}@${expected}`);
    if (selected.has(name)) return;
    selected.set(name, entry);
    for (const [dependency, required] of Object.entries(entry.requires)) include(dependency, required);
  }
  include("@slop-lab/dim-web");
  include("@slop-lab/dim-control-plane-admin");
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error(`unsafe local Web runtime directory: ${directory}`);
}
export type InstallCommand = (arguments_: readonly string[]) => void;
export async function installLocalWeb(bundle: string, dataHome: string, install: InstallCommand = (arguments_) => {
  const result = spawnSync("npm", [...arguments_], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`local Web npm installation failed (${result.status})`);
}): Promise<string> {
  if (!isAbsolute(bundle) || !isAbsolute(dataHome)) throw new Error("local Web installation requires absolute paths");
  const artifacts = webArtifacts(JSON.parse(await readFile(join(bundle, "packages.json"), "utf8")));
  const digest = createHash("sha256");
  for (const artifact of artifacts) {
    const file = join(bundle, artifact.file), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`unsafe local Web package artifact: ${file}`);
    digest.update(JSON.stringify(artifact)).update(await readFile(file));
  }
  const identity = digest.digest("hex"), runtime = join(dataHome, "web/runtime"), release = join(runtime, identity), current = join(runtime, "current");
  await ownedDirectory(dataHome);
  await ownedDirectory(join(dataHome, "web"));
  await ownedDirectory(runtime);
  const existing = await lstat(release).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (!existing) {
    const stage = join(runtime, `.install-${randomUUID()}`);
    await ownedDirectory(stage);
    try {
      install(["install", "--prefix", stage, "--no-save", "--no-fund", "--no-audit", "--ignore-scripts", "--omit=dev", ...artifacts.map(({ file }) => join(bundle, file))]);
      const executable = await realpath(join(stage, "node_modules/.bin/dim-web"));
      if (!executable.startsWith(`${stage}${sep}`)) throw new Error("local Web executable escapes its runtime");
      await writeFile(join(stage, ".dim-source-web"), identity, { flag: "wx", mode: 0o600 });
      await rename(stage, release);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  await ownedDirectory(release);
  const marker = join(release, ".dim-source-web"), markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || await readFile(marker, "utf8") !== identity) throw new Error("foreign local Web runtime");
  const executable = await realpath(join(release, "node_modules/.bin/dim-web"));
  if (!executable.startsWith(`${release}${sep}`)) throw new Error("local Web executable escapes its runtime");
  const selected = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (selected && (!selected.isSymbolicLink() || selected.uid !== process.getuid?.())) throw new Error("refusing foreign local Web runtime selection");
  const link = join(runtime, `.current-${randomUUID()}`);
  try { await symlink(basename(release), link); await rename(link, current); }
  finally { await rm(link, { force: true }); }
  return join(current, "node_modules/.bin/dim-web");
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2];
  if (!bundle || process.argv.length !== 3) throw new Error("Usage: node scripts/install-local-web.ts ABSOLUTE_PACKAGE_ROOT");
  const dataHome = process.env.DIM_DATA_HOME ?? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local/share"), "dim");
  console.log(`[host] Web UI executable: ${await installLocalWeb(bundle, dataHome)}`);
}
