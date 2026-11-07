import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { baselineImageDockerfile, baselineRecipeDigest, baselineRecipeFiles, baselineUbuntuSha256, consumeVmBaselines, hashBaselineFile, parseBaselineManifest, requireStandaloneQcow, type VmBaselineManifest } from "../../../scripts/checks/vm-baseline.ts";

const repository = resolve(import.meta.dirname, "../../.."), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-vm-baseline-test-")); roots.push(root);
  const images = {} as VmBaselineManifest["images"];
  for (const role of ["control-plane", "host"] as const) {
    const file = `${role}.qcow2`, path = join(root, file);
    await writeFile(path, `test dependency image: ${role}`, { mode: 0o444 });
    images[role] = { file, sha256: await hashBaselineFile(path), bytes: (await stat(path)).size };
  }
  const manifest: VmBaselineManifest = { schemaVersion: 1, ubuntuSha256: baselineUbuntuSha256, recipeSha256: await baselineRecipeDigest(repository), images };
  const file = join(root, "manifest.json");
  await writeFile(file, JSON.stringify(manifest), { mode: 0o444 });
  return { root, manifest, file, destination: join(root, "private") };
}
const standalone = { format: "qcow2", "virtual-size": 32 * 1024 ** 3 };
it("omits the package list in actual generated cached cloud-init instead of emitting a schema-invalid empty list", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-baseline-cloud-init-")); roots.push(root);
  await writeFile(join(root, "login-key.pub"), "ssh-ed25519 TEST-LOGIN");
  await writeFile(join(root, "host-key.pub"), "ssh-ed25519 TEST-HOST");
  await writeFile(join(root, "host-key"), "TEST-ONLY-HOST-KEY\n");
  const result = spawnSync("bash", ["-euc", 'source "$1"; BOOTSTRAP_WORK_ROOT="$2"; BOOTSTRAP_BASELINE_DIRECTORY="$2"; BOOTSTRAP_CLOUD_PACKAGE_UPDATE=false; BOOTSTRAP_CLOUD_PACKAGES="[]"; bootstrap_guest_write_cloud_init "$2" examples-workspace-host', "cloud-init-fixture", join(repository, "scripts/checks/lib/bootstrap-ubuntu-vm-guest.bash"), root], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  const cloud = parse(await readFile(join(root, "user-data"), "utf8")) as Record<string, unknown>;
  expect(cloud["package_update"]).toBe(false);
  expect(Object.hasOwn(cloud, "packages")).toBe(false);
});
it("exports the actual builder recipe through a spawned CLI without invoking another operation", () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/checks/vm-baseline.ts"), "recipe-files"], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([...baselineRecipeFiles]);
  expect(result.stderr).not.toContain("Usage:");
});
it("sets disk permissions in COPY without copying large lower-layer disks into another layer", () => {
  const dockerfile = baselineImageDockerfile(`registry.example/hardware@sha256:${"a".repeat(64)}`);
  expect(dockerfile).toContain("COPY --chmod=0444 baselines/control-plane.qcow2 baselines/host.qcow2 baselines/manifest.json /opt/dim/tools/baselines/");
  expect(dockerfile.split("\n").filter(line => line.startsWith("RUN "))).toEqual(["RUN chmod 0555 /opt/dim/tools/baselines"]);
  expect(() => baselineImageDockerfile("operator/image:mutable")).toThrow("exact digest");
});
it("copies and hashes both immutable dependencies before inspecting only their private paths", async () => {
  const f = await fixture(), inspected: string[] = [];
  const result = await consumeVmBaselines(f.file, f.destination, repository, file => { inspected.push(file); return standalone; });
  expect(result).toEqual(f.manifest);
  expect(inspected).toEqual([join(f.destination, "control-plane.qcow2"), join(f.destination, "host.qcow2")]);
  for (const path of inspected) expect((await stat(path)).mode & 0o777).toBe(0o400);
  expect(JSON.parse(await readFile(join(f.destination, "manifest.json"), "utf8"))).toEqual(f.manifest);
  await expect(consumeVmBaselines(f.file, f.destination, repository)).rejects.toMatchObject({ code: "EEXIST" });
});
it("rejects stale recipes without constructing a guest or silently replacing the baseline", async () => {
  const f = await fixture(); await chmod(f.file, 0o600);
  await writeFile(f.file, JSON.stringify({ ...f.manifest, recipeSha256: "0".repeat(64) }));
  await expect(consumeVmBaselines(f.file, f.destination, repository, () => { throw new Error("must not inspect"); })).rejects.toThrow("recipe/toolchain changed");
  await expect(stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
});
it("fails closed and removes only its private copy when dependency bytes differ", async () => {
  const f = await fixture(), path = join(f.root, "host.qcow2"); await chmod(path, 0o600); await writeFile(path, "tampered");
  await expect(consumeVmBaselines(f.file, f.destination, repository, () => standalone)).rejects.toThrow("integrity failed");
  expect(await readFile(path, "utf8")).toBe("tampered");
  await expect(stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects metadata path traversal, unknown roles, symlinks and writable cache entries", async () => {
  const f = await fixture();
  expect(() => parseBaselineManifest({ ...f.manifest, images: { ...f.manifest.images, host: { ...f.manifest.images.host, file: "../private.qcow2" } } })).toThrow("invalid VM baseline image");
  expect(() => parseBaselineManifest({ ...f.manifest, credential: "forbidden" })).toThrow();
  const link = join(f.root, "manifest-link.json"); await symlink(f.file, link);
  await expect(consumeVmBaselines(link, f.destination, repository)).rejects.toThrow("operator-owned");
  await chmod(join(f.root, "host.qcow2"), 0o666);
  await expect(consumeVmBaselines(f.file, f.destination, repository, () => standalone)).rejects.toThrow("operator-owned");
});
it("rejects every external backing or qcow2 data-file dependency", () => {
  expect(() => requireStandaloneQcow(standalone)).not.toThrow();
  for (const field of ["backing-filename", "full-backing-filename", "data-file"]) expect(() => requireStandaloneQcow({ ...standalone, [field]: "/operator/private" })).toThrow("standalone");
  expect(() => requireStandaloneQcow({ ...standalone, "format-specific": { data: { "data-file": "/operator/private" } } })).toThrow("external");
  expect(() => requireStandaloneQcow({ format: "raw", "virtual-size": 32 * 1024 ** 3 })).toThrow("standalone");
});
