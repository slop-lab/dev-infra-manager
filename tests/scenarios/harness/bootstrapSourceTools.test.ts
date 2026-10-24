import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/bash\nset -euo pipefail\n${body}`);
  await chmod(path, 0o755);
}

it("bootstraps without mise using pinned source tools instead of unsupported distro Node", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dim-bootstrap-source-tools-"));
  roots.push(root);
  const scripts = resolve(root, "scripts/checks");
  const tools = resolve(root, "tools");
  const pinned = resolve(root, "pinned");
  const log = resolve(root, "commands.log");
  await Promise.all([mkdir(resolve(scripts, "lib"), { recursive: true }), mkdir(resolve(root, "scripts/lib"), { recursive: true }), mkdir(tools), mkdir(resolve(pinned, "bin"), { recursive: true })]);
  await writeFile(log, "");
  await copyFile(resolve(workspaceRoot, "scripts/checks/bootstrap-ubuntu.bash"), resolve(scripts, "bootstrap-ubuntu.bash"));
  await copyFile(resolve(workspaceRoot, "scripts/checks/lib/runtime-backends.bash"), resolve(scripts, "lib/runtime-backends.bash"));
  await writeFile(resolve(root, "scripts/lib/bootstrap-ubuntu-pins.bash"), `dim_source_tools_root='${pinned}'\ndim_node_root='${pinned}'\n`);
  await executable(resolve(scripts, "lib/install-source-tools-ubuntu.bash"), 'printf "install-pinned-tools\\n" >>"$DIM_TEST_LOG"\n');
  await executable(resolve(scripts, "install-host-ubuntu.bash"), 'printf "install-host %s\\n" "$*" >>"$DIM_TEST_LOG"\n');
  await executable(resolve(tools, "sudo"), 'printf "sudo %s\\n" "$*" >>"$DIM_TEST_LOG"\nexec "$@"\n');
  await executable(resolve(pinned, "bin/pnpm"), 'printf "pinned-pnpm %s\\n" "$*" >>"$DIM_TEST_LOG"\n');
  await executable(resolve(pinned, "bin/just"), 'printf "pinned-just %s\\n" "$*" >>"$DIM_TEST_LOG"\n');

  const result = spawnSync("/usr/bin/bash", [resolve(scripts, "bootstrap-ubuntu.bash"), "sysbox"], {
    encoding: "utf8",
    env: { PATH: `${tools}:/usr/bin:/bin`, HOME: root, DIM_TEST_LOG: log },
  });

  expect(result, result.stderr).toMatchObject({ status: 0 });
  const commands = await readFile(log, "utf8");
  expect(commands).toContain("install-pinned-tools");
  expect(commands).toContain("install-host sysbox");
  expect(commands).toContain("pinned-pnpm install --frozen-lockfile");
  expect(commands).toContain("pinned-just run-cli doctor");
  expect(commands).not.toContain("apt-get");
  expect(commands).not.toContain("npm install -g");
});
