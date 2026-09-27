import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type LifecycleReadiness = "failure" | "mismatch" | "success" | "unowned";

export type QemuLifecycleFixture = {
  readonly cliLog: string;
  readonly newPidFile: string;
  readonly root: string;
  readonly serviceDirectory: string;
  readonly tools: string;
};

export function qemuSetupSection(setup: string, serviceDirectory: string): string {
  const start = setup.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
  const end = setup.indexOf("\n# Avoid inheriting", start);
  if (start < 0 || end < 0) throw new TypeError("QEMU setup section was not found");
  return `set -eu\n${setup.slice(start, end).replace(
    "qemu_service_dir=/tmp/dim-qemu-verification", `qemu_service_dir=${JSON.stringify(serviceDirectory)}`,
  ).replace("qemu_node=/usr/bin/node", 'qemu_node="$DIM_TEST_NODE"')
    .replaceAll("sudo -n ", '"$DIM_TEST_SUDO" ')
    .replaceAll("/usr/bin/env -i", "/usr/bin/env")}`;
}

export function lifecycleEnvironment(fixture: QemuLifecycleFixture, readiness: LifecycleReadiness): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixture.tools}:/usr/bin:/bin`,
    DIM_TEST_NEW_PID_FILE: fixture.newPidFile,
    DIM_TEST_NODE: resolve(fixture.tools, "node"),
    DIM_TEST_SUDO: resolve(fixture.tools, "sudo"),
    DIM_TEST_CHILD_PID_FILE: resolve(fixture.root, "child-service.pid"),
    DIM_TEST_OWNER_CLI_LOG: fixture.cliLog,
    DIM_TEST_OWNER_PATH: resolve(fixture.serviceDirectory, "service-owner.json"),
    DIM_TEST_READINESS: readiness,
    DIM_TEST_READINESS_RELEASE: resolve(fixture.root, "readiness-release"),
    DIM_TEST_REAL_NODE: process.execPath,
    DIM_TEST_SIGNAL_LOG: resolve(fixture.root, "signals.log"),
    DIM_TEST_SIGNAL_PRELOAD: resolve(fixture.root, "signal-preload.mjs"),
    DIM_WORKSPACE_DATA: fixture.root,
    DIM_WORKSPACE_KVM: "1",
  };
}

export async function copyLifecycleSnapshots(projectRoot: string, fixtureRoot: string): Promise<{
  readonly newLifecycleRoot: string; readonly oldLifecycleRoot: string;
}> {
  const oldLifecycleRoot = resolve(fixtureRoot, "lifecycle-old");
  const newLifecycleRoot = resolve(fixtureRoot, "lifecycle-new");
  await Promise.all([mkdir(oldLifecycleRoot), mkdir(newLifecycleRoot)]);
  await Promise.all([
    cp(resolve(projectRoot, ".dim"), resolve(oldLifecycleRoot, ".dim"), { recursive: true }),
    cp(resolve(projectRoot, ".dim"), resolve(newLifecycleRoot, ".dim"), { recursive: true }),
  ]);
  return { newLifecycleRoot, oldLifecycleRoot };
}

export async function qemuTeardownSection(lifecycleRoot: string, serviceDirectory: string): Promise<string> {
  const teardown = await readFile(resolve(lifecycleRoot, ".dim/teardown.sh"), "utf8");
  const start = teardown.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
  const end = teardown.indexOf("\nset -- down", start);
  if (start < 0 || end < 0) throw new TypeError("QEMU teardown section was not found");
  return `set -eu\n${teardown.slice(start, end).replace(
    "qemu_service_dir=/tmp/dim-qemu-verification", `qemu_service_dir=${JSON.stringify(serviceDirectory)}`,
  ).replace("qemu_node=/usr/bin/node", `qemu_node=${JSON.stringify(process.execPath)}`)
    .replaceAll("sudo -n ", '"$DIM_TEST_SUDO" ')}`;
}
