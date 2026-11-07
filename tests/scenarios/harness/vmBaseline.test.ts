import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { baselineRecipeDigest, baselineUbuntuSha256, consumeVmBaselines, hashBaselineFile, parseBaselineManifest, requireStandaloneQcow, type VmBaselineManifest } from "../../../scripts/checks/vm-baseline.ts";

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
