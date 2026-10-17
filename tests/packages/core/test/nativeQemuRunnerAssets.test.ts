import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const assets = new URL("../../../../core/packages/core/src/native-qemu-runner-assets/", import.meta.url);

describe("native QEMU runner resource boundary", () => {
  it("ships syntactically valid launch scripts and rejects an incomplete launcher invocation", () => {
    // Given
    const launcher = fileURLToPath(new URL("dim-native-qemu-run", assets));
    const init = fileURLToPath(new URL("guest-init", assets));

    // When
    const launcherSyntax = spawnSync("/bin/sh", ["-n", launcher]);
    const initSyntax = spawnSync("/bin/sh", ["-n", init]);
    const incomplete = spawnSync("/bin/sh", [launcher], { encoding: "utf8" });

    // Then
    expect(launcherSyntax.status).toBe(0);
    expect(initSyntax.status).toBe(0);
    expect(incomplete.status).toBe(64);
    expect(incomplete.stderr).toContain("invalid native QEMU runner invocation");
  });

  it("runs Bash-only candidate syntax from a writable workspace with profiles disabled", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-bash-"));
    const workspace = join(root, "workspace");
    const script = join(root, "script");
    await mkdir(workspace);
    await writeFile(script, "set -o pipefail\nvalues=(candidate executed)\nprintf '%s:%s:%s\\n' \"${values[0]}\" \"${values[1]}\" \"$PWD\" > result\n");

    // When
    const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", script], {
      cwd: workspace, encoding: "utf8"
    });

    // Then
    expect(execution.status).toBe(0);
    await expect(readFile(join(workspace, "result"), "utf8"))
      .resolves.toBe(`candidate:executed:${workspace}\n`);
  });

  it("pins both runner image stages to the reviewed base digest", async () => {
    // Given
    const dockerfile = await readFile(new URL("Dockerfile", assets), "utf8");

    // When
    const bases = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));

    // Then
    expect(bases).toHaveLength(2);
    expect(bases.every((line) => line.includes("alpine:3.22.2@sha256:") && /@sha256:[0-9a-f]{64}/u.test(line)))
      .toBe(true);
    expect(dockerfile).toContain("-name '*.ko.gz' -exec gunzip");
    expect(dockerfile).toContain('depmod -b /build/root "$kernel_release"');
  });

  it("applies the trusted CPU and memory bounds to QEMU", async () => {
    // Given
    const launcher = await readFile(new URL("dim-native-qemu-run", assets), "utf8");

    // When
    const qemuArguments = launcher.match(/-machine q35,accel=kvm[^\n]+/u)?.[0];

    // Then
    expect(qemuArguments).toContain('-smp "$cpus"');
    expect(qemuArguments).toContain('-m "${memory_mib}M"');
    expect(launcher).toContain('guest_memory_bytes=${6-}');
    expect(launcher).toContain('memory_mib=$((guest_memory_bytes / 1048576))');
    expect(launcher).toContain('dim.pids=$pids');
    expect(launcher).toContain('id=workspace,path=/run/dim/workspace,security_model=mapped-xattr');
  });

  it("places the guest job process tree under the trusted PID limit", async () => {
    // Given
    const init = await readFile(new URL("guest-init", assets), "utf8");

    // When
    const cgroupWrites = init.split("\n").filter((line) => line.includes("/sys/fs/cgroup/dim-job/"));

    // Then
    expect(init).toContain("printf '+pids\\n' >/sys/fs/cgroup/cgroup.subtree_control");
    expect(cgroupWrites).toEqual([
      "printf '%s\\n' \"$pids\" >/sys/fs/cgroup/dim-job/pids.max",
      "printf '%s\\n' \"$$\" >/sys/fs/cgroup/dim-job/cgroup.procs"
    ]);
  });

  it("executes the candidate without privilege or writable kernel control mounts", async () => {
    // Given
    const [dockerfile, init, executor] = await Promise.all([
      readFile(new URL("Dockerfile", assets), "utf8"),
      readFile(new URL("guest-init", assets), "utf8"),
      readFile(new URL("guest-exec.c", assets), "utf8")
    ]);

    // When / Then
    expect(dockerfile).toContain("guest-exec.c");
    expect(init).toContain("mount -o remount,bind,ro /guest/proc");
    expect(init).toContain("mount -o remount,bind,ro /guest/sys");
    expect(init).toContain("mount --bind /sys/fs/cgroup /guest/sys/fs/cgroup");
    expect(init).toContain("mount -o remount,bind,ro /guest/sys/fs/cgroup");
    expect(init).toContain("mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /guest/tmp");
    expect(init).toContain("chown -R 1000:1000 /guest/workspace");
    expect(init).toContain("/bin/busybox modprobe 9p\n/bin/busybox modprobe 9pnet_virtio");
    expect(init).toContain("/guest-exec /guest /workspace 1000 1000 /bin/bash --noprofile --norc /run/dim/job/script");
    expect(executor).toContain("PR_SET_NO_NEW_PRIVS");
    expect(executor).toContain("setgroups(0, NULL)");
    expect(executor).toContain("setgid(gid)");
    expect(executor).toContain("setuid(uid)");
    expect(executor).toContain("execv(argv[5], &argv[5])");
  });
});
