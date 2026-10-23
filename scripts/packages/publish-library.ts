import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "./publish-package-version.ts";

interface LibraryMetadata {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly bin?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: object;
  readonly devDependencies?: object;
}
function exportPaths(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/^\.\/src\/(.*)\.ts$/, "./$1.d.ts").replace(/^\.\/dist\//, "./");
  if (Array.isArray(value)) return value.map(exportPaths);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "dim-source" && key !== "source").map(([key, entry]) => [key, exportPaths(entry)]));
  return value;
}
/** Publish only declared entrypoints and exact workspace dependencies from a built library. */
export async function publishLibrary(directory: URL, source: LibraryMetadata): Promise<void> {
  if (source.private !== true) throw new Error("source library must remain private");
  const { private: _private, scripts: _scripts, devDependencies: _development, ...metadata } = source;
  const version = publishPackageVersion(source.version);
  const versions = (entries: Readonly<Record<string, string>> = {}) => Object.fromEntries(
    Object.entries(entries).map(([name, selected]) => [name, selected.startsWith("workspace:") || name.startsWith("@slop-lab/dim-") ? version : selected]));
  await writeFile(new URL("dist/package.json", directory), JSON.stringify({ ...metadata, version,
    main: "./index.js", types: "./index.d.ts", exports: exportPaths(source.exports),
    ...(source.bin === undefined ? {} : { bin: exportPaths(source.bin) }),
    dependencies: versions(source.dependencies), peerDependencies: versions(source.peerDependencies)
  }, null, 2) + "\n");
  for (const target of Object.values(source.bin ?? {})) await chmod(new URL(target.replace(/^\.\/dist\//, "dist/"), directory), 0o755);
  const license = await readFile(new URL("../../LICENSE", import.meta.url));
  await writeFile(new URL("dist/LICENSE", directory), license);
  await copyFile(new URL("README.md", directory), new URL("dist/README.md", directory));
}
