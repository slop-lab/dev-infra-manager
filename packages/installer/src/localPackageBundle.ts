import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface LocalPackageBundle {
  readonly version: string;
  readonly packageSpecifiers: readonly string[];
  readonly packageNames: readonly string[];
}

interface BundlePackage {
  name: string;
  version: string;
  file: string;
  requires: Readonly<Record<string, string>>;
}

/** A local bundle is an artifact graph; optional artifacts are not install roots. */
export async function readLocalPackageBundle(
  directory: string,
  selectedPackages: readonly string[] = []
): Promise<LocalPackageBundle> {
  return readArtifactClosure(directory, ["@slop-lab/dim-cli", "@slop-lab/dim-host-core", ...selectedPackages], "@slop-lab/dim-cli");
}

export async function readControlPlanePackageBundle(directory: string, selectedSpecifiers: readonly string[]): Promise<LocalPackageBundle> {
  const versions = selectedPluginVersions(selectedSpecifiers);
  return readArtifactClosure(directory, ["@slop-lab/dim-control-plane-core", ...versions.keys()], "@slop-lab/dim-control-plane-core", versions);
}

export async function readHostPluginPackageBundle(directory: string, selectedSpecifiers: readonly string[], retainedPlugins: readonly string[] = []): Promise<LocalPackageBundle> {
  const versions = selectedPluginVersions(selectedSpecifiers);
  return readArtifactClosure(directory, ["@slop-lab/dim-cli", "@slop-lab/dim-host-core", ...retainedPlugins, ...versions.keys()], "@slop-lab/dim-cli", versions);
}

function selectedPluginVersions(selectedSpecifiers: readonly string[]): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const specifier of selectedSpecifiers) {
    const separator = specifier.lastIndexOf("@"), name = specifier.slice(0, separator), version = specifier.slice(separator + 1);
    if (separator <= 0 || !packageName.test(name) || !exactVersion.test(version)) throw new Error("--local-packages requires exact PACKAGE@VERSION plugin selections");
    if (versions.has(name)) throw new Error(`duplicate selected plugin '${name}'`);
    versions.set(name, version);
  }
  return versions;
}

async function readArtifactClosure(directory: string, roots: readonly string[], runtime: string, expectedVersions: ReadonlyMap<string, string> = new Map()): Promise<LocalPackageBundle> {
  const bundleDirectory = path.resolve(directory);
  const manifestPath = path.join(bundleDirectory, "packages.json");
  const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!record(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.packages)) {
    throw new Error(`invalid local package bundle manifest: ${manifestPath}`);
  }
  const packages = new Map<string, BundlePackage>();
  for (const entry of raw.packages) {
    if (!record(entry) || typeof entry.name !== "string" || !packageName.test(entry.name)
      || typeof entry.version !== "string" || !exactVersion.test(entry.version)
      || typeof entry.file !== "string") throw new Error(`invalid local package entry in ${manifestPath}`);
    if (packages.has(entry.name)) throw new Error(`duplicate local package '${entry.name}'`);
    if (path.basename(entry.file) !== entry.file || !entry.file.endsWith(".tgz")) {
      throw new Error(`invalid local package filename '${entry.file}'`);
    }
    if (!record(entry.requires) || Object.entries(entry.requires)
      .some(([name, version]) => !packageName.test(name) || typeof version !== "string" || !exactVersion.test(version))) {
      throw new Error(`invalid local dependency graph for '${entry.name}'; regenerate the package bundle`);
    }
    packages.set(entry.name, { name: entry.name, version: entry.version, file: entry.file,
      requires: entry.requires as Readonly<Record<string, string>> });
  }
  for (const [name, version] of expectedVersions) {
    if (packages.get(name)?.version !== version) throw new Error(`local bundle does not match selected plugin '${name}@${version}'`);
  }
  const selected = new Set<string>();
  const include = (name: string): void => {
    if (name === "@slop-lab/dim-installer") throw new Error("the installer facade cannot be selected as a runtime dependency");
    if (selected.has(name)) return;
    const entry = packages.get(name);
    if (entry === undefined) throw new Error(`local package bundle does not contain required package '${name}'`);
    selected.add(name);
    for (const [dependency, version] of Object.entries(entry.requires)) {
      const target = packages.get(dependency);
      if (target === undefined) throw new Error(`local package '${name}' requires missing bundle package '${dependency}@${version}'`);
      if (target.version !== version) {
        throw new Error(`local package '${name}' requires '${dependency}@${version}', but the bundle contains '${target.version}'`);
      }
      include(dependency);
    }
  };
  for (const name of roots) include(name);
  if (runtime === "@slop-lab/dim-control-plane-core" && [...selected].some((name) => ["@slop-lab/dim-cli", "@slop-lab/dim-host-core", "@slop-lab/dim-control-plane-admin"].includes(name) || name.startsWith("@slop-lab/dim-host-plugin-"))) {
    throw new Error("control-plane bundle closure must not include host CLI, core, admin or host plugin packages");
  }
  const entries = [...packages.values()].filter(({ name }) => selected.has(name));
  const specifiers = entries.map(({ file }) => path.join(bundleDirectory, file));
  await Promise.all(specifiers.map((file) => access(file, constants.R_OK)));
  return { version: packages.get(runtime)!.version,
    packageSpecifiers: specifiers, packageNames: entries.map(({ name }) => name) };
}

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
