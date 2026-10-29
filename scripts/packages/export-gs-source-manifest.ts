import { posix } from "node:path";
import { SourceExportError } from "./export-gs-source-types.ts";
import type { DependencyKind, DependencyRecord, PackageRecord, TreeEntry } from "./export-gs-source-types.ts";

const dependencyKinds = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(entry: TreeEntry): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.content));
  } catch (error) {
    throw new SourceExportError(`invalid package manifest: ${entry.sourcePath}`, { cause: error });
  }
  if (!isJsonObject(parsed)) throw new SourceExportError(`package manifest is not an object: ${entry.sourcePath}`);
  return parsed;
}

function requiredString(manifest: JsonObject, field: string, sourcePath: string): string {
  const value = manifest[field];
  if (typeof value !== "string" || value.length === 0) throw new SourceExportError(`${sourcePath} requires string field ${field}`);
  return value;
}

function packageRecord(entry: TreeEntry, manifest: JsonObject): PackageRecord {
  const exportPath = posix.dirname(entry.exportPath);
  const version = manifest["version"];
  if (version !== undefined && typeof version !== "string") throw new SourceExportError(`${entry.sourcePath} has a non-string version`);
  return {
    name: requiredString(manifest, "name", entry.sourcePath),
    sourcePath: entry.sourcePath,
    exportPath,
    manifestBlobId: entry.blobId,
    private: manifest["private"] === true,
    ...(version === undefined ? {} : { version }),
  };
}

function dependencyEntries(manifest: JsonObject, kind: DependencyKind, sourcePath: string): readonly [string, string][] {
  const value = manifest[kind];
  if (value === undefined) return [];
  if (!isJsonObject(value)) throw new SourceExportError(`${sourcePath} has a non-object ${kind}`);
  return Object.entries(value).map(([name, specifier]) => {
    if (typeof specifier !== "string") throw new SourceExportError(`${sourcePath} dependency ${name} has a non-string specifier`);
    return [name, specifier];
  });
}

function isDimDependency(name: string): boolean {
  return name.startsWith("@slop-lab/dim-") || name.startsWith("@this-project/dim-");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function packageClosure(entries: readonly TreeEntry[]): {
  readonly packages: readonly PackageRecord[];
  readonly dependencies: readonly DependencyRecord[];
} {
  const manifests = entries.filter((entry) => entry.exportPath === "package.json" || /^[^/]+\/package\.json$/.test(entry.exportPath))
    .map((entry) => ({ entry, manifest: parseManifest(entry) }));
  const packages = manifests.map(({ entry, manifest }) => packageRecord(entry, manifest))
    .sort((left, right) => compareText(left.exportPath, right.exportPath));
  const names = new Set<string>();
  for (const package_ of packages) {
    if (names.has(package_.name)) throw new SourceExportError(`duplicate GS package name: ${package_.name}`);
    names.add(package_.name);
  }
  const dependencies: DependencyRecord[] = [];
  for (const { entry, manifest } of manifests) {
    const from = requiredString(manifest, "name", entry.sourcePath);
    for (const kind of dependencyKinds) {
      for (const [name, specifier] of dependencyEntries(manifest, kind, entry.sourcePath)) {
        if (isDimDependency(name)) throw new SourceExportError(`${from} declares DIM dependency ${name}`);
        const workspaceDependency = specifier.startsWith("workspace:");
        const gsDependency = name.startsWith("@slop-lab/gs-") || name === "@this-project/gs-workspace";
        if ((workspaceDependency || gsDependency) && !names.has(name)) throw new SourceExportError(`${from} has unclosed GS workspace dependency ${name}`);
        dependencies.push({ from, name, kind, specifier, ...(names.has(name) ? { target: name } : {}) });
      }
    }
  }
  dependencies.sort((left, right) => compareText(left.from, right.from) || compareText(left.name, right.name) || compareText(left.kind, right.kind));
  return { packages, dependencies };
}
