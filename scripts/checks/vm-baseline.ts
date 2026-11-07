import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const baselineUbuntuSha256 = "6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2";
export const baselineRecipeFiles = [
  "scripts/checks/vm-baseline.ts", "scripts/checks/lib/prepare-vm-baselines.bash", "scripts/checks/lib/verify-vm-baselines.bash",
  "scripts/checks/lib/bootstrap-ubuntu-vm-guest.bash", "scripts/checks/lib/install-source-tools-ubuntu.bash",
  "scripts/checks/lib/install-trusted-qemu-node.bash", "scripts/checks/lib/install-docker-ce-ubuntu.bash",
  "scripts/checks/lib/install-practical-vm-dependencies-ubuntu.bash",
  "scripts/checks/install-host-ubuntu.bash", "scripts/checks/install-rootlesskit-apparmor-profile-ubuntu.bash",
  "scripts/checks/lib/runtime-backends.bash", "scripts/checks/lib/bootstrap-download.bash",
  "scripts/lib/bootstrap-ubuntu-pins.bash", "scripts/lib/bootstrap-host-preflight.bash"
] as const;
type Image = { file: string; sha256: string; bytes: number };
export type VmBaselineManifest = { schemaVersion: 1; ubuntuSha256: string; recipeSha256: string; images: { "control-plane": Image; host: Image } };
const root = fileURLToPath(new URL("../../", import.meta.url));
const roles = ["control-plane", "host"] as const;
const sha = /^[a-f0-9]{64}$/;

export async function baselineRecipeDigest(repository: string): Promise<string> {
  const digest = createHash("sha256").update(baselineUbuntuSha256);
  for (const file of baselineRecipeFiles) digest.update(file).update("\0").update(await readFile(join(repository, file))).update("\0");
  return digest.digest("hex");
}
export async function hashBaselineFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
function exactKeys(value: object, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
export function parseBaselineManifest(value: unknown): VmBaselineManifest {
  if (!value || typeof value !== "object" || !exactKeys(value, ["schemaVersion", "ubuntuSha256", "recipeSha256", "images"])) throw new Error("invalid VM baseline manifest");
  const manifest = value as VmBaselineManifest;
  if (manifest.schemaVersion !== 1 || manifest.ubuntuSha256 !== baselineUbuntuSha256 || !sha.test(manifest.recipeSha256)
    || !manifest.images || typeof manifest.images !== "object" || !exactKeys(manifest.images, roles)) throw new Error("invalid VM baseline identity");
  for (const role of roles) {
    const image = manifest.images[role];
    if (!image || typeof image !== "object" || !exactKeys(image, ["file", "sha256", "bytes"]) || image.file !== `${role}.qcow2`
      || !sha.test(image.sha256) || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > 64 * 1024 ** 3) throw new Error("invalid VM baseline image");
  }
  return manifest;
}
async function trustedFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!isAbsolute(file) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0) throw new Error("VM baseline must be an operator-owned regular non-writable file");
}
function run(file: string, args: string[], timeout = 30_000): string {
  const result = spawnSync(file, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`VM baseline command failed: ${file}: ${(result.stderr || result.error?.message || "unknown failure").slice(-4096)}`);
  return result.stdout;
}
export function requireStandaloneQcow(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("invalid qcow2 metadata");
  const info = value as Record<string, unknown>;
  if (info["format"] !== "qcow2" || info["backing-filename"] !== undefined || info["full-backing-filename"] !== undefined
    || info["data-file"] !== undefined || typeof info["virtual-size"] !== "number" || info["virtual-size"] <= 0 || info["virtual-size"] > 64 * 1024 ** 3) throw new Error("VM baseline must be standalone qcow2 without external backing/data files");
  const specific = info["format-specific"] as { data?: Record<string, unknown> } | undefined;
  if (specific?.data?.["data-file"] !== undefined) throw new Error("external qcow2 data files are forbidden");
}
export function baselineImageDockerfile(supervisor: string): string {
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(supervisor)) throw new Error("baseline supervisor requires an exact digest");
  return `FROM ${supervisor}\nCOPY --chmod=0444 baselines/control-plane.qcow2 baselines/host.qcow2 baselines/manifest.json /opt/dim/tools/baselines/\nRUN chmod 0555 /opt/dim/tools/baselines\n`;
}
/** Validate the private copies that QEMU consumes, never hash then reopen the shared cache. */
export async function consumeVmBaselines(manifestFile: string, destination: string, repository = root,
  inspectImage: (file: string) => unknown = (file) => JSON.parse(run("qemu-img", ["info", "--output=json", file]))): Promise<VmBaselineManifest> {
  await trustedFile(manifestFile);
  if ((await lstat(manifestFile)).size > 8192) throw new Error("VM baseline manifest exceeds bound");
  const manifest = parseBaselineManifest(JSON.parse(await readFile(manifestFile, "utf8")));
  if (manifest.recipeSha256 !== await baselineRecipeDigest(repository)) throw new Error("VM baseline recipe/toolchain changed; rebuild the operator baseline or run cold installation");
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const role of roles) {
      const entry = manifest.images[role], source = join(dirname(manifestFile), entry.file), target = join(destination, entry.file);
      await trustedFile(source);
      await copyFile(source, target, constants.COPYFILE_EXCL);
      const copied = await lstat(target);
      if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1 || copied.size !== entry.bytes || await hashBaselineFile(target) !== entry.sha256) throw new Error(`VM baseline integrity failed: ${role}`);
      requireStandaloneQcow(inspectImage(target));
      await chmod(target, 0o400);
    }
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest) + "\n", { mode: 0o400, flag: "wx" });
    return manifest;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

async function main(args: string[]): Promise<void> {
  const [operation, first, second, third] = args;
  if (operation === "recipe-files" && args.length === 1) {
    console.log(baselineRecipeFiles.join("\n"));
  } else if (operation === "consume" && first && second && args.length === 3) {
    await consumeVmBaselines(resolve(first), resolve(second));
  } else if (operation === "clone-check" && first && second && args.length === 3) {
    if (!isAbsolute(first) || !isAbsolute(second)) throw new Error("clone-check requires absolute manifest and new evidence directory");
    await mkdir(second, { mode: 0o700 });
    const privateImages = join(second, "private-images");
    await consumeVmBaselines(first, privateImages);
    try {
      const checked = spawnSync("bash", [join(root, "scripts/checks/lib/verify-vm-baselines.bash"), root, privateImages, second], { stdio: "inherit", timeout: 45 * 60_000 });
      if (checked.status !== 0) throw new Error("baseline real-clone identity qualification failed");
    } finally { await rm(privateImages, { recursive: true, force: true }); }
  } else if (operation === "build" && first && second && args.length === 3) {
    if (!isAbsolute(first) || !isAbsolute(second)) throw new Error("build requires absolute new output and Ubuntu image paths");
    await trustedFile(second);
    if (await hashBaselineFile(second) !== baselineUbuntuSha256) throw new Error("Ubuntu baseline input digest mismatch");
    await mkdir(first, { mode: 0o700 });
    const result = spawnSync("bash", [join(root, "scripts/checks/lib/prepare-vm-baselines.bash"), root, first, second], { stdio: "inherit", timeout: 3 * 60 * 60_000 });
    if (result.status !== 0) throw new Error("VM baseline build failed; incomplete output is not a consumable baseline");
    const images = {} as VmBaselineManifest["images"];
    for (const role of roles) {
      const file = `${role}.qcow2`, path = join(first, file);
      requireStandaloneQcow(JSON.parse(run("qemu-img", ["info", "--output=json", path])));
      images[role] = { file, sha256: await hashBaselineFile(path), bytes: (await lstat(path)).size };
      await chmod(path, 0o444);
    }
    const manifest: VmBaselineManifest = { schemaVersion: 1, ubuntuSha256: baselineUbuntuSha256, recipeSha256: await baselineRecipeDigest(root), images };
    await writeFile(join(first, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o444, flag: "wx" });
    console.log(JSON.stringify({ baselineManifest: join(first, "manifest.json"), ...manifest }));
  } else if (operation === "image" && first && second && third && args.length === 4) {
    if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(second) || !/^[a-z0-9][a-z0-9./:_-]*:[a-z0-9._-]+$/.test(third) || third.endsWith(":latest")) throw new Error("baseline image requires an exact supervisor digest and explicit non-latest target tag");
    const stage = await mkdtemp(join(tmpdir(), "dim-baseline-image-"));
    try {
      await consumeVmBaselines(resolve(first), join(stage, "baselines"));
      await writeFile(join(stage, "Dockerfile"), baselineImageDockerfile(second));
      const built = spawnSync("docker", ["build", "--tag", third, stage], { stdio: "inherit", timeout: 30 * 60_000 });
      if (built.status !== 0) throw new Error("baseline supervisor image build failed");
      console.log(run("docker", ["image", "inspect", third, "--format", "{{.Id}}"]));
    } finally { await rm(stage, { recursive: true, force: true }); }
  } else throw new Error("Usage: node scripts/checks/vm-baseline.ts build NEW_OUTPUT PINNED_UBUNTU | consume MANIFEST NEW_PRIVATE_DIRECTORY | clone-check MANIFEST NEW_EVIDENCE | image MANIFEST SUPERVISOR@sha256:DIGEST TARGET:TAG");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
