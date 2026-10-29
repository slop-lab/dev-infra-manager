import { createHash } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { SourceExportError } from "./export-gs-source-types.ts";
import type { ExportedFile, TreeEntry } from "./export-gs-source-types.ts";

function safeExportPath(exportPath: string): void {
  if (posix.isAbsolute(exportPath) || posix.normalize(exportPath) !== exportPath || exportPath === ".." || exportPath.startsWith("../")) {
    throw new SourceExportError(`unsafe exported path: ${exportPath}`);
  }
}

function safeSymlinkTarget(entry: TreeEntry): string {
  let target: string;
  try {
    target = new TextDecoder("utf-8", { fatal: true }).decode(entry.content);
  } catch (error) {
    throw new SourceExportError(`symlink target is not valid UTF-8: ${entry.sourcePath}`, { cause: error });
  }
  if (target.length === 0 || posix.isAbsolute(target)) throw new SourceExportError(`unsafe symlink target: ${entry.sourcePath}`);
  return target;
}

function validateSymlinkResolution(exportPath: string, target: string, symlinks: ReadonlyMap<string, string>): void {
  const resolved = posix.dirname(exportPath) === "." ? [] : posix.dirname(exportPath).split("/");
  const pending = target.split("/");
  let hops = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    if (!component || component === ".") continue;
    if (component === "..") {
      if (resolved.length === 0) throw new SourceExportError(`symlink escapes exported source: ${exportPath}`);
      resolved.pop();
      continue;
    }
    resolved.push(component);
    const expanded = symlinks.get(resolved.join("/"));
    if (expanded === undefined) continue;
    hops += 1;
    if (hops > symlinks.size) throw new SourceExportError(`symlink cycle in exported source: ${exportPath}`);
    resolved.pop();
    pending.unshift(...expanded.split("/"));
  }
}

export function validateEntries(entries: readonly TreeEntry[]): void {
  const symlinks = new Map<string, string>();
  for (const entry of entries) {
    safeExportPath(entry.exportPath);
    if (entry.mode === "120000") symlinks.set(entry.exportPath, safeSymlinkTarget(entry));
  }
  for (const [exportPath, target] of symlinks) {
    validateSymlinkResolution(exportPath, target, symlinks);
  }
}

export async function writeSource(sourceDirectory: string, entries: readonly TreeEntry[]): Promise<readonly ExportedFile[]> {
  await mkdir(sourceDirectory, { mode: 0o700 });
  const files: ExportedFile[] = [];
  for (const entry of entries) {
    const destination = join(sourceDirectory, entry.exportPath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (entry.mode === "120000") {
      await symlink(safeSymlinkTarget(entry), destination);
    } else {
      const mode = entry.mode === "100755" ? 0o755 : 0o644;
      await writeFile(destination, entry.content, { flag: "wx", mode });
      await chmod(destination, mode);
    }
    files.push({
      sourcePath: entry.sourcePath,
      exportPath: entry.exportPath,
      blobId: entry.blobId,
      mode: entry.mode,
      sha256: createHash("sha256").update(entry.content).digest("hex"),
    });
  }
  return files;
}
