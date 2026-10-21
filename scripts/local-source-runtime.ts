import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid local source package manifest");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("invalid local source package manifest string");
  return value;
}
interface Artifact { name: string; version: string; file: string; requires: Record<string, string> }
/** Select an exact local artifact closure for an isolated optional runtime. */
export function localArtifacts(manifest: unknown, roots: readonly string[]): Artifact[] {
  const value = object(manifest);
  if (value.schemaVersion !== 1 || !Array.isArray(value.packages)) throw new Error("invalid local source package manifest");
  const records = value.packages.map((input) => {
    const entry = object(input), file = text(entry.file);
    if (basename(file) !== file || !file.endsWith(".tgz")) throw new Error("unsafe local source package artifact path");
    return { name: text(entry.name), version: text(entry.version), file,
      requires: Object.fromEntries(Object.entries(object(entry.requires ?? {})).map(([name, version]) => [name, text(version)])) };
  });
  const catalog = new Map(records.map((entry) => [entry.name, entry]));
  if (catalog.size !== records.length) throw new Error("duplicate local package name");
  const version = catalog.get("@slop-lab/dim-cli")?.version;
  if (!version) throw new Error("local source bundle lacks matching CLI version");
  const selected = new Map<string, Artifact>();
  function include(name: string, expected = version): void {
    const entry = catalog.get(name);
    if (!entry || entry.version !== expected || entry.version !== version) throw new Error(`local source bundle lacks matching ${name}@${expected}`);
    if (selected.has(name)) return;
    selected.set(name, entry);
    for (const [dependency, required] of Object.entries(entry.requires)) include(dependency, required);
  }
  for (const name of roots) include(name);
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error(`unsafe local source runtime directory: ${directory}`);
}
export type InstallCommand = (arguments_: readonly string[]) => void;
export async function installLocalRuntime(bundle: string, dataHome: string, options: {
  readonly component: "web" | "llm-operator" | "shared-ingress";
  readonly packages: readonly string[];
  readonly executable: string;
  readonly install?: InstallCommand;
}): Promise<string> {
  const install = options.install ?? ((arguments_: readonly string[]) => {
    const result = spawnSync("npm", [...arguments_], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`local source npm installation failed (${result.status})`);
  });
  const markerName = `.dim-source-${options.component}`;
  if (!isAbsolute(bundle) || !isAbsolute(dataHome)) throw new Error("local source installation requires absolute paths");
  const artifacts = localArtifacts(JSON.parse(await readFile(join(bundle, "packages.json"), "utf8")), options.packages);
  const digest = createHash("sha256");
  for (const artifact of artifacts) {
    const file = join(bundle, artifact.file), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`unsafe local source package artifact: ${file}`);
    digest.update(JSON.stringify(artifact)).update(await readFile(file));
  }
  const identity = digest.digest("hex"), runtime = join(dataHome, options.component, "runtime"), release = join(runtime, identity), current = join(runtime, "current");
  await ownedDirectory(dataHome);
  await ownedDirectory(join(dataHome, options.component));
  await ownedDirectory(runtime);
  const existing = await lstat(release).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (!existing) {
    const stage = join(runtime, `.install-${randomUUID()}`);
    await ownedDirectory(stage);
    try {
      install(["install", "--prefix", stage, "--no-save", "--no-fund", "--no-audit", "--ignore-scripts", "--omit=dev", ...artifacts.map(({ file }) => join(bundle, file))]);
      const executable = await realpath(join(stage, "node_modules/.bin", options.executable));
      if (!executable.startsWith(`${stage}${sep}`)) throw new Error("local source executable escapes its runtime");
      await writeFile(join(stage, markerName), identity, { flag: "wx", mode: 0o600 });
      await rename(stage, release);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  await ownedDirectory(release);
  const marker = join(release, markerName), markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || await readFile(marker, "utf8") !== identity) throw new Error("foreign local source runtime");
  const executable = await realpath(join(release, "node_modules/.bin", options.executable));
  if (!executable.startsWith(`${release}${sep}`)) throw new Error("local source executable escapes its runtime");
  const selected = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (selected && (!selected.isSymbolicLink() || selected.uid !== process.getuid?.())) throw new Error("refusing foreign local source runtime selection");
  const link = join(runtime, `.current-${randomUUID()}`);
  try { await symlink(basename(release), link); await rename(link, current); }
  finally { await rm(link, { force: true }); }
  return join(current, "node_modules/.bin", options.executable);
}
