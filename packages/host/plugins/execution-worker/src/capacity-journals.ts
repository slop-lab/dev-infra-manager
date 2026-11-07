import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { executionArtifactManifestSchema } from "@slop-lab/dim-contracts-execution";
import { executionResultSchema } from "@slop-lab/dim-contracts-ci/aggregate";

/** Recognize terminal receipts without removing or rewriting a single retained byte. */
export async function historicalCapacityArtifacts(root: string, id: string): Promise<boolean> {
  async function json(name: string): Promise<unknown> {
    const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error("unsafe terminal receipt");
      return JSON.parse(await file.readFile("utf8")) as unknown;
    } finally { await file.close(); }
  }
  try {
    const manifest = executionArtifactManifestSchema.parse(await json("manifest.json"));
    if (manifest.executionId !== id) return false;
    const names = await readdir(root), allowed = new Set(["manifest.json", "empty-stdout", "empty-stderr", ...manifest.artifacts.map(a => a.id)]);
    let terminal = false;
    for (const marker of ["upload-interrupted.json", "upload-timeout.json"]) if (names.includes(marker)) {
      const row = await json(marker);
      if (!row || typeof row !== "object" || Reflect.get(row, "schemaVersion") !== 1 || Reflect.get(row, "executionId") !== id
        || !Number.isSafeInteger(Reflect.get(row, "deadlineAt"))) return false;
      const command = executionResultSchema.parse(Reflect.get(row, "commandResult"));
      if (command.executionId !== id || command.descriptorDigest !== manifest.descriptorDigest) return false;
      if (marker === "upload-interrupted.json") { if (Reflect.get(row, "reason") !== "execution-lease-lost") return false; }
      else {
        const result = executionResultSchema.parse(Reflect.get(row, "reportedFailure"));
        if (result.executionId !== id || result.descriptorDigest !== manifest.descriptorDigest || result.result !== "failure"
          || result.completion.kind !== "executor-failure" || !("code" in result.completion) || result.completion.code !== "artifact-upload-timeout") return false;
      }
      allowed.add(marker); terminal = true;
    }
    if (!terminal || names.some(name => !allowed.has(name))) return false;
    for (const name of names) {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return false;
      const artifact = manifest.artifacts.find(a => a.id === name);
      if (artifact && stat.size !== artifact.bytes || name.startsWith("empty-") && stat.size !== 0) return false;
    }
    return manifest.artifacts.every(artifact => names.includes(artifact.id));
  } catch { return false; }
}
