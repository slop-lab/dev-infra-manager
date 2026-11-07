import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { baselineRecipeFiles } from "../../../scripts/checks/vm-baseline.ts";

const repository = resolve(import.meta.dirname, "../../.."), roots: string[] = [];
const relative = "scripts/checks/lib/install-practical-vm-dependencies-ubuntu.bash";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { uid?: number; aptExit?: number; dnsExit?: number; agent?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dim-practical-deps-")); roots.push(root);
  const bin = join(root, "bin"), log = join(root, "commands.log"); await mkdir(bin);
  async function tool(name: string, body: string) { const p = join(bin, name); await writeFile(p, `#!/bin/bash\nset -euo pipefail\n${body}\n`); await chmod(p, 0o755); }
  await tool("id", `printf '%s\\n' '${options.uid ?? 0}'`);
  await tool("apt-get", `printf 'apt-get %s\\n' "$*" >>"$DIM_FIXTURE_LOG"; if [[ "$1" == install ]]; then test "$DEBIAN_FRONTEND" = noninteractive; exit ${options.aptExit ?? 0}; fi`);
  await tool("dnsmasq", `printf 'dnsmasq %s\\n' "$*" >>"$DIM_FIXTURE_LOG"; exit ${options.dnsExit ?? 0}`);
  await tool("virtiofsd", 'printf "virtiofsd %s\\n" "$*" >>"$DIM_FIXTURE_LOG"');
  // Real QEMU reports supported SPICE help with exit 1, not a capability result.
  await tool("qemu-system-x86_64", 'printf "qemu %s\\n" "$*" >>"$DIM_FIXTURE_LOG"; printf "spice options:\\n"; exit 1');
  if (options.agent !== false) await tool("incus-agent", "exit 99"); // Presence only; never start an agent on the host.
  const script = join(root, "install.bash");
  await writeFile(script, (await readFile(join(repository, relative), "utf8"))
    .replaceAll("/usr/libexec/incus/incus-agent", join(bin, "incus-agent"))
    .replaceAll("/usr/libexec/virtiofsd", join(bin, "virtiofsd")));
  const result = spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, DIM_FIXTURE_LOG: log }, timeout: 10_000 });
  return { result, commands: await readFile(log, "utf8").catch(() => "") };
}
it("installs explicit Incus DNS, agent, shared-filesystem and SPICE support without GUI recommendations", async () => {
  const f = await fixture(); expect(f.result.status, f.result.stderr).toBe(0);
  expect(f.commands).toContain("apt-get update\n");
  const install = f.commands.split("\n").find(line => line.startsWith("apt-get install "))!.split(" ");
  for (const name of ["--no-install-recommends", "incus", "incus-agent", "dnsmasq-base", "virtiofsd", "qemu-system-modules-spice", "genisoimage"]) expect(install).toContain(name);
  expect(install).not.toContain("qemu-system-gui");
  expect(f.commands).toContain("dnsmasq --version\n"); expect(f.commands).toContain("virtiofsd --version\n");
  expect(f.commands).not.toContain("qemu -spice help\n");
});
it("does not accept an installed package list when its DNS executable fails", async () => {
  const f = await fixture({ dnsExit: 127 }); expect(f.result.status).toBe(1);
  expect(f.result.stderr).toContain("working dnsmasq"); expect(f.commands).not.toContain("virtiofsd --version");
});
it("requires a usable agent binary without starting it and preserves APT failure", async () => {
  const absent = await fixture({ agent: false }); expect(absent.result.status).toBe(1); expect(absent.result.stderr).toContain("VM agent is unavailable");
  const apt = await fixture({ aptExit: 23 }); expect(apt.result.status).toBe(23); expect(apt.commands).not.toContain("dnsmasq --version");
});
it("rejects unprivileged installation before APT and binds cold and baseline callers to the same recipe", async () => {
  const f = await fixture({ uid: 1001 }); expect(f.result.status).toBe(1); expect(f.commands).toBe("");
  expect(baselineRecipeFiles).toContain(relative);
  const cold = await readFile(join(repository, "tests/scenarios/selected-host/ci/prepareHost.ts"), "utf8");
  const baseline = await readFile(join(repository, "scripts/checks/lib/prepare-vm-baselines.bash"), "utf8");
  expect(cold).toContain(relative); expect(baseline).toContain(`sudo bash ${relative}`);
});
