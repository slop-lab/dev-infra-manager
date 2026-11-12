import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { BackendInput } from "../backend.js";
import { artifactArchiveLimit, artifactArchivePath, indexArtifactFiles, type BackendArtifactSource } from "../artifact-source.js";
import { stopOwnedNativeContainer } from "./containers.js";

export async function exportContainerArtifacts(input: BackendInput, id: string, nonce: string): Promise<BackendArtifactSource> {
  let error: "artifact-stop-failed" | "artifact-metadata-rejected" | "artifact-export-failed" = "artifact-stop-failed";
  const path = artifactArchivePath(input.root, nonce);
  let created = false;
  try {
    await stopOwnedNativeContainer(input.runner, input.grant, id);
    error = "artifact-metadata-rejected";
    const index = await indexArtifactFiles(input.root);
    if (index.length === 0) return { kind: "archive", nonce, index };
    error = "artifact-export-failed";
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    try {
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
      let count = 0, errors = 0;
      const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) {
        count += chunk.length;
        if (count > artifactArchiveLimit(index)) { abort.abort(); callback(new Error("artifact archive bound exceeded")); }
        else file.writeFile(chunk).then(() => callback(), callback);
      } });
      const stderr = new Writable({ write(chunk: Buffer, _encoding, callback) {
        errors += chunk.length; if (errors > 4096) abort.abort(); callback();
      } });
      stdout.on("error", () => abort.abort());
      const drained = finished(stdout); drained.catch(() => {});
      try {
        const exit = await input.runner.runStreaming("docker", ["cp", `${id}:/workspace/.dim-ci-artifacts`, "-"], { signal, stdout, stderr });
        if (!stdout.writableEnded) stdout.end();
        await drained;
        if (exit !== 0 || signal.aborted || count === 0) throw new Error("artifact export failed");
      } finally { stdout.destroy(); stderr.destroy(); await drained.catch(() => {}); }
      await file.sync();
    } finally { await file.close(); }
    error = "artifact-metadata-rejected";
    const after = await indexArtifactFiles(input.root);
    if (JSON.stringify(index) !== JSON.stringify(after)) throw new Error("artifact metadata changed");
    return { kind: "archive", nonce, index };
  } catch {
    if (created) await rm(path);
    return { kind: "unavailable", nonce, error };
  }
}
