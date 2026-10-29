import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHistoryBundle, inspectGitSource, readGsTree, readMonorepoLock } from "./export-gs-source-git.ts";
import { validateEntries, writeSource } from "./export-gs-source-files.ts";
import { packageClosure } from "./export-gs-source-manifest.ts";
import { bundleRef, SourceExportError, sourcePrefix } from "./export-gs-source-types.ts";
import type { ExportArguments, ExportManifest } from "./export-gs-source-types.ts";

const usage = "Usage: node scripts/packages/export-gs-source.ts --source ABSOLUTE_REPOSITORY --commit FULL_OBJECT_ID --output NEW_ABSOLUTE_DIRECTORY\n";

function parseArguments(arguments_: readonly string[]): ExportArguments | "help" {
  if (arguments_.length === 1 && arguments_[0] === "--help") return "help";
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key || !value || !["--source", "--commit", "--output"].includes(key) || values.has(key)) throw new SourceExportError("invalid command arguments");
    values.set(key, value);
  }
  const source = values.get("--source");
  const commit = values.get("--commit");
  const output = values.get("--output");
  if (!source || !commit || !output || values.size !== 3) throw new SourceExportError("source, commit, and output are required");
  return { source, commit, output };
}

async function resolveLocations(arguments_: ExportArguments): Promise<ExportArguments> {
  if (!isAbsolute(arguments_.source) || !isAbsolute(arguments_.output)) throw new SourceExportError("source and output paths must be absolute");
  const source = await realpath(arguments_.source);
  const output = resolve(arguments_.output);
  const outputParent = await realpath(dirname(output));
  const canonicalOutput = join(outputParent, basename(output));
  const fromSource = relative(source, canonicalOutput);
  if (fromSource === "" || (!fromSource.startsWith("..") && !isAbsolute(fromSource))) throw new SourceExportError("output must be outside the source repository");
  if (existsSync(canonicalOutput)) throw new SourceExportError("output already exists");
  return { source, commit: arguments_.commit, output: canonicalOutput };
}

async function exportSource(arguments_: ExportArguments): Promise<void> {
  const locations = await resolveLocations(arguments_);
  const context = inspectGitSource(locations.source, locations.commit);
  const entries = readGsTree(context);
  validateEntries(entries);
  const closure = packageClosure(entries);
  const monorepoLock = readMonorepoLock(context);
  let ownsOutput = false;
  try {
    await mkdir(locations.output, { mode: 0o700 });
    ownsOutput = true;
    const files = await writeSource(join(locations.output, "source"), entries);
    const bundleSha256 = await createHistoryBundle(context, join(locations.output, "source-history.bundle"));
    const manifest: ExportManifest = {
      schemaVersion: 1,
      source: { commit: context.commit, tree: context.tree, prefixTree: context.prefixTree, objectFormat: context.objectFormat, prefix: sourcePrefix },
      bundle: { path: "source-history.bundle", ref: bundleRef, sha256: bundleSha256 },
      monorepoLock,
      files,
      packages: closure.packages,
      dependencies: closure.dependencies,
    };
    await writeFile(join(locations.output, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ output: locations.output, commit: context.commit, files: files.length, packages: closure.packages.length })}\n`);
  } catch (error) {
    if (ownsOutput) await rm(locations.output, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> { // no-excuse-ok: catch
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    if (arguments_ === "help") {
      process.stdout.write(usage);
      return;
    }
    await exportSource(arguments_);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "source export failed"}\n`);
    process.exitCode = 1;
  }
}

await main();
