import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vitest";
const run = promisify(execFile), helper = resolve(import.meta.dirname, "../../../scripts/checks/lib/examples-separated-vms.bash");
it("retains separate VM ownership and pinned SSH selection while switching roles", async () => {
  const { stdout } = await run("bash", ["-c", `set -euo pipefail
source "$1"
BOOTSTRAP_QEMU_PID=101 BOOTSTRAP_QEMU_START=1001 BOOTSTRAP_GUEST_ROOT=/private/cp BOOTSTRAP_GUEST_IDENTITY=1:2 BOOTSTRAP_SSH_PORT=2201
examples_vm_save control-plane
BOOTSTRAP_QEMU_PID=102 BOOTSTRAP_QEMU_START=1002 BOOTSTRAP_GUEST_ROOT=/private/host BOOTSTRAP_GUEST_IDENTITY=1:3 BOOTSTRAP_SSH_PORT=2202
examples_vm_save host
examples_vm_select control-plane
printf '%s\\n' "$BOOTSTRAP_QEMU_PID:$BOOTSTRAP_QEMU_START:$BOOTSTRAP_GUEST_IDENTITY:$BOOTSTRAP_SSH_PORT" "\${BOOTSTRAP_SSH[*]}"
examples_vm_select host
printf '%s\\n' "$BOOTSTRAP_QEMU_PID:$BOOTSTRAP_QEMU_START:$BOOTSTRAP_GUEST_IDENTITY:$BOOTSTRAP_SSH_PORT" "\${BOOTSTRAP_SSH[*]}"
`, "test", helper]);
  const lines = stdout.trim().split("\n");
  expect(lines[0]).toBe("101:1001:1:2:2201"); expect(lines[2]).toBe("102:1002:1:3:2202");
  expect(lines[1]).toContain("StrictHostKeyChecking=yes"); expect(lines[1]).toContain("/private/cp/known_hosts");
  expect(lines[3]).toContain("/private/host/known_hosts"); expect(lines[3]).toContain("-p 2202");
});
it("cleans both saved roles and an unsaved partial boot, retaining failed ownership for diagnosis", async () => {
  const { stdout } = await run("bash", ["-c", `set -euo pipefail
source "$1"
BOOTSTRAP_QEMU_PID=101 BOOTSTRAP_QEMU_START=1001 BOOTSTRAP_GUEST_ROOT=/private/cp BOOTSTRAP_GUEST_IDENTITY=1:2 BOOTSTRAP_SSH_PORT=2201
examples_vm_save control-plane
BOOTSTRAP_QEMU_PID=102 BOOTSTRAP_QEMU_START=1002 BOOTSTRAP_GUEST_ROOT=/private/host BOOTSTRAP_GUEST_IDENTITY=1:3 BOOTSTRAP_SSH_PORT=2202
examples_vm_save host
BOOTSTRAP_QEMU_PID=103
bootstrap_guest_stop() { printf 'stop:%s\\n' "$BOOTSTRAP_QEMU_PID"; if [[ "$BOOTSTRAP_QEMU_PID" == 101 ]]; then return 1; fi; BOOTSTRAP_QEMU_PID=""; }
if bootstrap_examples_stop_all; then exit 99; fi
printf 'retained:%s\\n' "\${EXAMPLES_VM_PID[control-plane]}"
[[ ! -v EXAMPLES_VM_PID[host] ]]
`, "test", helper]);
  expect(stdout.trim().split("\n")).toEqual(["stop:103", "stop:102", "stop:101", "retained:101"]);
});
