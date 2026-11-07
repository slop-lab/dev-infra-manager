import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { requireHardwareProfile } from "../../../../packages/host/plugins/execution-worker/src/hardwareProfile.js";
import { qemuContainerArguments } from "../../../../packages/host/plugins/execution-worker/src/backends/qemu.js";
import { assignment, grant, event } from "../../../contracts/ci/executionFixture.js";
const selected = grant({ ...assignment(), event: event("practical", "qemu") });
const descriptor = { ...selected.descriptor, jobImage: selected.descriptor.runnerBaseImage,
  bounds: { ...selected.descriptor.bounds, cpu: "4", memoryBytes: String(20 * 1024 ** 3), wallClockSeconds: "10800" } };
it("requires operator image identity and sufficient hardware bounds without changing tiny QEMU", () => {
  expect(requireHardwareProfile(null, selected.descriptor)).toBe(false);
  expect(requireHardwareProfile("ubuntu-hardware-v1", descriptor)).toBe(true);
  expect(() => requireHardwareProfile("candidate-selected", descriptor)).toThrow("unknown");
  expect(() => requireHardwareProfile("ubuntu-hardware-v1", { ...descriptor, jobImage: "other@sha256:" + "a".repeat(64) })).toThrow("identical");
  for (const bounds of [{ ...descriptor.bounds, memoryBytes: "1024" }, { ...descriptor.bounds, cpu: "2" }, { ...descriptor.bounds, wallClockSeconds: "3600" }])
    expect(() => requireHardwareProfile("ubuntu-hardware-v1", { ...descriptor, bounds })).toThrow("20 GiB");
});
it("separates private hardware disks from the only candidate-visible workspace share", () => {
  const input = { grant: selected, root: "/private/job" }, identity = { uid: 1000, gid: 1000, kvmGroup: 108 };
  expect(qemuContainerArguments(input, identity)).not.toContain("type=bind,src=/private/job/hardware,dst=/run/dim/hardware");
  const args = qemuContainerArguments(input, identity, undefined, true);
  expect(args).toContain("type=bind,src=/private/job/hardware,dst=/run/dim/hardware");
  expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|password|credential/);
});
it.each([[85, "0\n", 0], [87, "23\n", 23], [87, "255\n", 255], [85, "23\n", 1], [0, "0\n", 1], [87, "256\n", 1], [87, "23\n0\n", 1]])("preserves bounded guest exit receipt %s/%s", async (code, text, expected) => {
  const source = await readFile(new URL("../../../../packages/host/plugins/execution-worker/src/ubuntu-hardware-runner-assets/supervisor.ts", import.meta.url), "utf8");
  const body = /child.once\("close", code => \{([\s\S]*)\n\}\);\s*$/.exec(source)?.[1];
  expect(body).toBeTruthy();
  const process = { getuid: () => 1000, exitCode: -1 };
  runInNewContext(body!, { code, process, directory: "/private", join: (...parts: string[]) => parts.join("/"),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 1000, size: text.length }), readFileSync: () => text });
  expect(process.exitCode).toBe(expected);
});
