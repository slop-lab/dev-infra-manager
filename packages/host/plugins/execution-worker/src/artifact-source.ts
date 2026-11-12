import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { executionArtifactLimits } from "@slop-lab/dim-contracts-execution";

export type ArtifactIndexEntry = { readonly name: string; readonly kind: "file" | "directory"; readonly size: number; readonly identity: string };
export type BackendArtifactSource =
  | { readonly kind: "archive"; readonly nonce: string; readonly index: readonly ArtifactIndexEntry[] }
  | { readonly kind: "unavailable"; readonly nonce: string; readonly error: "artifact-stop-failed" | "artifact-export-failed" | "artifact-metadata-rejected" };
export const artifactPaxBytes = 16 * 1024;
export function artifactArchivePath(root: string, nonce: string): string { return join(root, "artifacts-" + z.string().uuid().parse(nonce) + ".tar"); }
export function artifactArchiveLimit(index: readonly ArtifactIndexEntry[]): number {
  return index.reduce((sum, entry) => sum + Math.ceil(entry.size / 512) * 512 + artifactPaxBytes + 1536, 1024 + 10240);
}
export class ArtifactHandoffError extends Error { constructor() { super("artifact handoff rejected"); } }

export async function indexArtifactFiles(root: string): Promise<readonly ArtifactIndexEntry[]> {
  const directory = join(root, "workspace", ".dim-ci-artifacts"), entries: ArtifactIndexEntry[] = [];
  for (const path of [root, join(root, "workspace")]) {
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new ArtifactHandoffError();
  }
  try { await lstat(directory); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return entries;
    throw error;
  }
  let files = 0, bytes = 0;
  async function visit(name: string, depth: number): Promise<void> {
    if (depth > 16 || entries.length >= 512) throw new ArtifactHandoffError();
    const path = name ? join(directory, name) : directory, info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) throw new ArtifactHandoffError();
    if (info.isFile() && (info.nlink !== 1n || ++files > executionArtifactLimits.files || info.size > BigInt(executionArtifactLimits.fileBytes))) throw new ArtifactHandoffError();
    const size = info.isFile() ? Number(info.size) : 0;
    bytes += size; if (bytes > executionArtifactLimits.totalBytes) throw new ArtifactHandoffError();
    entries.push({ name, kind: info.isDirectory() ? "directory" : "file", size,
      identity: [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":") });
    if (info.isDirectory()) {
      const dir = await opendir(path);
      for await (const entry of dir) {
        if (!entry.name || entry.name.includes("\\") || /[\x00-\x1f\x7f]/.test(entry.name)) throw new ArtifactHandoffError();
        const relative = name ? name + "/" + entry.name : entry.name;
        if (Buffer.byteLength(relative) > 506) throw new ArtifactHandoffError();
        await visit(relative, depth + 1);
      }
    }
  }
  await visit("", 0);
  return entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
