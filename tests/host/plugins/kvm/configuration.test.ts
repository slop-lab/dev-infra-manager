import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { kvmDevice } from "../../../../packages/host/plugins/kvm/src/index.js";

it("rejects missing, regular, symlinked or publicly accessible device configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-kvm-config-")), directory = join(root, "plugins/kvm");
  try {
    await expect(kvmDevice(root)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "kvm"), "not a device", { mode: 0o666 });
    await expect(kvmDevice(root)).rejects.toThrow(/unexpected identity/);
    await rm(join(directory, "kvm")); await symlink("/dev/kvm", join(directory, "kvm"));
    await expect(kvmDevice(root)).rejects.toThrow(/unexpected identity/);
    await rm(directory, { recursive: true }); await mkdir(directory, { mode: 0o755 });
    await expect(kvmDevice(root)).rejects.toThrow(/not private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
