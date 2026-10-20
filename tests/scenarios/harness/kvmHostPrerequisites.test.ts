import { spawnSync } from "node:child_process";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const smokeSource = resolve(workspaceRoot, "scripts/checks/kvm-host-install-smoke.bash");
const prerequisites = resolve(workspaceRoot, "scripts/checks/lib/kvm-host-prerequisites.bash");
const roots: string[] = [];
const modules = [
  "qemu-event-followers.mts", "qemu-input-handoff.mts", "qemu-values.mts", "qemu-owner-record.mts", "qemu-process-group.mts", "qemu-run-finalization.mts",
  "qemu-service-artifacts.mts", "qemu-service-filesystem.mts", "qemu-service-http.mts", "qemu-service-owner.mts",
  "qemu-service-startup.mts", "qemu-service.mts", "qemu-snapshot.mts",
] as const;

type PreflightFixture = {
  readonly root: string;
  readonly runtimeTools: string;
  readonly serviceDirectory: string;
  readonly smoke: string;
  readonly sudo: string;
};

async function preflightFixture(): Promise<PreflightFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-kvm-preflight-test-"));
  roots.push(root);
  await chmod(root, 0o755);
  const projectRoot = resolve(root, "project");
  const projectQemu = resolve(projectRoot, "tests/scenarios/qemu");
  const tools = resolve(root, "tools");
  const smoke = resolve(root, "kvm-host-install-smoke.bash");
  const sudo = resolve(tools, "sudo");
  const serviceDirectory = resolve(root, "service");
  await mkdir(projectQemu, { recursive: true });
  await mkdir(tools);
  for (const command of ["qemu-system-x86_64", "qemu-img", "cloud-localds"] as const) {
    await writeFile(resolve(tools, command), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  }
  await Promise.all([...modules, "qemu-client.mts"].map((module) =>
    copyFile(resolve(workspaceRoot, "tests/scenarios/qemu", module), resolve(projectQemu, module))));
  await writeFile(resolve(root, "launcher.bash"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  await writeFile(sudo, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
  const source = await readFile(smokeSource, "utf8");
  await writeFile(smoke, source
    .replace(/^repository_root=.*$/m, `repository_root=${JSON.stringify(projectRoot)}`)
    .replace(/^source .*kvm-host-prerequisites.*$/m, `source ${JSON.stringify(prerequisites)}`)
    .replace(/^invoking_uid=.*$/m, "invoking_uid=1000")
    .replace(/^invoking_gid=.*$/m, "invoking_gid=1000")
    .replace(/^sudo_command=.*$/m, `sudo_command=${JSON.stringify(sudo)}`)
    .replace(/^runtime_path=.*$/m, `runtime_path=${JSON.stringify(`${tools}:/usr/bin:/bin`)}`)
    .replace(/^service_dir=.*$/m, `service_dir=${JSON.stringify(serviceDirectory)}`)
    .replace(/^kvm_device=.*$/m, `kvm_device=${JSON.stringify(resolve(root, "missing-kvm"))}`));
  await chmod(smoke, 0o700);
  return { root, runtimeTools: tools, serviceDirectory, smoke, sudo };
}

function runPreflight(fixture: PreflightFixture, node: string) {
  return spawnSync("/usr/bin/bash", [fixture.smoke, "--preflight-only"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DIM_QEMU_NODE_EXECUTABLE: node,
      DIM_QEMU_TRUSTED_LAUNCHER: resolve(fixture.root, "launcher.bash"),
      PATH: `${fixture.runtimeTools}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("KVM host prerequisite preflight", () => {
  it("rejects a non-x86_64 host before QEMU execution", () => {
    // Given / When
    const result = spawnSync("/usr/bin/bash", ["-c", `
source "$1"
QEMU_PREFLIGHT_FAILURES=()
qemu_host_architecture() { printf 'aarch64\\n'; }
qemu_check_host_architecture
printf '%s\\n' "\${QEMU_PREFLIGHT_FAILURES[@]}"
`, "preflight-architecture-test", prerequisites], { encoding: "utf8" });

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unsupported QEMU KVM host architecture: aarch64");
  });

  it("reports Node, sudo, and KVM deficiencies together without creating privileged runtime state", async () => {
    // Given
    const fixture = await preflightFixture();

    // When
    const result = runPreflight(fixture, resolve(fixture.root, "missing-node"));

    // Then
    expect(result.status).toBe(2);
    expect.soft(result.stderr).toContain("trusted Node.js interpreter");
    expect.soft(result.stderr).toContain("sudo -n preflight failed");
    expect.soft(result.stderr).toContain("/dev/kvm must be a readable and writable character device");
    await expect(lstat(fixture.serviceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an explicit trusted Node interpreter without resolving a PATH shim", async () => {
    // Given
    const fixture = await preflightFixture();
    await writeFile(fixture.sudo, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    const source = await readFile(fixture.smoke, "utf8");
    await writeFile(fixture.smoke, source.replace(/^kvm_device=.*$/m, "kvm_device=/dev/null"));
    const shim = resolve(fixture.root, "node");
    await writeFile(shim, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o700 });

    // When
    const result = spawnSync("/usr/bin/bash", [fixture.smoke, "--preflight-only"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, DIM_QEMU_NODE_EXECUTABLE: process.execPath,
        DIM_QEMU_TRUSTED_LAUNCHER: resolve(fixture.root, "launcher.bash"),
        PATH: `${fixture.root}:${resolve(fixture.root, "tools")}:/usr/bin:/bin` },
    });

    // Then
    expect(result, result.stderr).toMatchObject({ status: 0 });
    await expect(lstat(fixture.serviceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a dependency available only on the caller PATH", async () => {
    // Given
    const fixture = await preflightFixture();
    await writeFile(fixture.sudo, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    await rm(resolve(fixture.runtimeTools, "qemu-img"));
    const callerTools = resolve(fixture.root, "caller-tools");
    await mkdir(callerTools);
    await writeFile(resolve(callerTools, "qemu-img"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    const source = await readFile(fixture.smoke, "utf8");
    await writeFile(fixture.smoke, source.replace(/^kvm_device=.*$/m, "kvm_device=/dev/null"));

    // When
    const result = spawnSync("/usr/bin/bash", [fixture.smoke, "--preflight-only"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DIM_QEMU_NODE_EXECUTABLE: process.execPath,
        DIM_QEMU_TRUSTED_LAUNCHER: resolve(fixture.root, "launcher.bash"),
        PATH: `${callerTools}:${fixture.runtimeTools}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
    });

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing KVM smoke dependency: qemu-img");
  });

  it.each(["symlink", "user-owned-ancestor"])("rejects a Node path with a %s trust chain", async (kind) => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-kvm-node-trust-test-"));
    roots.push(root);
    await chmod(root, 0o755);
    if (kind === "user-owned-ancestor") await chown(root, 1000, 1000);
    const node = resolve(root, "node");
    if (kind === "symlink") await symlink(process.execPath, node);
    else await copyFile(process.execPath, node);

    // When
    const result = spawnSync("/usr/bin/bash", ["-c",
      'source "$1"; qemu_validate_trusted_node "$2"', "preflight-test", prerequisites, node], { encoding: "utf8" });

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("trusted Node.js interpreter");
  });
});
