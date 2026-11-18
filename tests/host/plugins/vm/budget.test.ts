import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { LinuxVmBudget } from "../../../../packages/host/plugins/vm/src/budget.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  rmdir: vi.fn(),
}));

it.each([{ member: "", attempts: 2 }, { member: "102\n", attempts: 1 }])(
  "rechecks VM cgroup membership after a busy removal (member: $member)",
  async ({ member, attempts }) => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-vm-budget-release-"));
    const instance = "dim-00000000-0000-4000-8000-000000000001";
    const group = path.join(root, instance);
    const processes = path.join(group, "cgroup.procs");
    const remove = vi.mocked(rmdir);
    try {
      await mkdir(group);
      await writeFile(processes, "");
      remove.mockReset();
      remove.mockImplementationOnce(async () => {
        await writeFile(processes, member);
        throw Object.assign(new Error("cgroup busy"), { code: "EBUSY" });
      }).mockResolvedValueOnce(undefined);

      const result = new LinuxVmBudget(root).release(instance);
      if (member) await expect(result).rejects.toThrow("live processes");
      else await expect(result).resolves.toBeUndefined();
      expect(remove).toHaveBeenCalledTimes(attempts);
      expect(remove).toHaveBeenCalledWith(group);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);
