import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UserError, type CommandRunner } from "@slop-lab/dim-core/workspace";
import { fingerprint, object, type VmHostConfig } from "./config.js";

export interface ReviewedImageDownload { url: string; sha256: string; rootfs?: { url: string; sha256: string } }

/** Acquisition is explicit host authority; creating a workspace only uses local fingerprints. */
export async function importReviewedImage(config: VmHostConfig, input: ReviewedImageDownload, runner: CommandRunner, signal: AbortSignal): Promise<string> {
  const helper = [new URL("./artifact-cache.bash", import.meta.url), new URL("../scripts/artifact-cache.bash", import.meta.url)].find(existsSync);
  if (!helper) throw new UserError("VM artifact cache helper is missing from the installed package");
  const acquire = async (download: { url: string; sha256: string }): Promise<string> => {
    if (!/^https?:\/\//.test(download.url) || /[\r\n\0]/.test(download.url)) throw new UserError("image URL must use HTTP or HTTPS");
    if (!/^[a-f0-9]{64}$/.test(download.sha256)) throw new UserError("image download requires a lowercase SHA-256 digest");
    const result = await runner.run("bash", [fileURLToPath(helper), download.url, download.sha256], { signal });
    if (result.exitCode !== 0) throw new UserError(`VM image download failed: ${result.stderr.trim()}`);
    const file = result.stdout.trim();
    if (!file.startsWith("/") || file.includes("\n") || !file.endsWith(`/${download.sha256}`)) throw new UserError("artifact cache returned an invalid image path");
    return file;
  };
  const files = [await acquire(input)];
  if (input.rootfs) files.push(await acquire(input.rootfs));
  const result = await runner.run("incus", ["--force-local", "--project", config.project, "image", "import", ...files], { signal, env: { ...process.env, INCUS_SOCKET: config.incusSocket, LC_ALL: "C" } });
  if (result.exitCode !== 0) throw new UserError(`Incus image import failed: ${result.stderr.trim()}`);
  const match = /Image imported with fingerprint: ([a-f0-9]{64})(?:\s|$)/.exec(`${result.stdout}\n${result.stderr}`);
  if (!match?.[1]) throw new UserError("Incus import did not return an image fingerprint");
  const importedFingerprint = fingerprint(match[1]);
  const inspection = await runner.run("incus", ["--force-local", "query", `/1.0/images/${importedFingerprint}?project=${encodeURIComponent(config.project)}`], { signal, env: { ...process.env, INCUS_SOCKET: config.incusSocket } });
  if (inspection.exitCode !== 0) throw new UserError(`cannot verify imported image: ${inspection.stderr.trim()}`);
  const imported = object(JSON.parse(inspection.stdout));
  if (imported.fingerprint !== importedFingerprint || imported.type !== "virtual-machine") throw new UserError("imported image is not the expected local virtual-machine image");
  return importedFingerprint;
}
