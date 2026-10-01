import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runStagedStatePreflight(stagingDirectory: string): Promise<void> {
  const coreDirectory = path.join(stagingDirectory, "node_modules", "@slop-lab", "dim-core");
  const metadata: unknown = JSON.parse(await readFile(path.join(coreDirectory, "package.json"), "utf8"));
  if (!isRecord(metadata) || !isRecord(metadata.exports) || !isRecord(metadata.exports["."])) {
    throw new Error("target @slop-lab/dim-core package has no root export metadata");
  }
  const coreImport = metadata.exports["."].import;
  if (typeof coreImport !== "string" || path.isAbsolute(coreImport)) {
    throw new Error("target @slop-lab/dim-core package has no valid root import export");
  }
  const coreEntry = path.resolve(coreDirectory, coreImport);
  const relativeEntry = path.relative(coreDirectory, coreEntry);
  if (relativeEntry === ".." || relativeEntry.startsWith(`..${path.sep}`)) {
    throw new Error("target @slop-lab/dim-core root import export escapes its package");
  }
  const candidate: unknown = await import(pathToFileURL(coreEntry).href);
  if (!isRecord(candidate) || typeof candidate.preflightStateCompatibility !== "function") {
    throw new Error("target @slop-lab/dim-core package does not provide the installation compatibility contract");
  }
  const result: unknown = await candidate.preflightStateCompatibility(process.env);
  if (!isRecord(result) || !Array.isArray(result.warnings) || !result.warnings.every((value) => typeof value === "string")) {
    throw new Error("target @slop-lab/dim-core package returned an invalid installation compatibility result");
  }
  for (const warning of result.warnings) console.warn(`dim: warning: ${warning}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
