import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const setupPath = resolve(workspaceRoot, ".dim/setup.sh");
const teardownPath = resolve(workspaceRoot, ".dim/teardown.sh");
const dockerfilePath = resolve(workspaceRoot, "core/images/project-workspace/Dockerfile");

describe("QEMU root command authority", () => {
  it("pins the Alpine Node interpreter independently of PATH", async () => {
    const [setup, teardown, dockerfile] = await Promise.all([
      readFile(setupPath, "utf8"), readFile(teardownPath, "utf8"), readFile(dockerfilePath, "utf8"),
    ]);

    expect.soft(setup).toContain("qemu_node=/usr/bin/node");
    expect.soft(teardown).toContain("qemu_node=/usr/bin/node");
    expect.soft(dockerfile).toMatch(/apk add --no-cache .* nodejs /);
    expect(`${setup}\n${teardown}`).not.toContain("command -v node");
  });

  it("resets disabled KVM state only through narrowed sudo operations", async () => {
    const setup = await readFile(setupPath, "utf8");
    const disabled = setup.slice(setup.indexOf("else\n  echo \"[setup] skip QEMU service\""), setup.indexOf("\nfi", setup.indexOf("else\n  echo \"[setup] skip QEMU service\"")));

    expect.soft(disabled).toContain('sudo -n /usr/bin/install -d -o root -g root -m 0755 "$qemu_service_dir"');
    expect.soft(disabled).toContain('qemu_root_owner retire "$qemu_service_dir/service-owner.json"');
    expect.soft(disabled).toContain('sudo -n /usr/bin/rm -rf "$qemu_service_dir"');
    expect(disabled.match(/sudo -n \/usr\/bin\/install/g)).toHaveLength(2);
  });

  it("uses minimal root environments and absolute lifecycle-snapshot scripts", async () => {
    const [setup, teardown] = await Promise.all([readFile(setupPath, "utf8"), readFile(teardownPath, "utf8")]);
    const rootCommands = `${setup.slice(setup.indexOf("qemu_project_root="), setup.indexOf("\n# Avoid inheriting"))}\n${teardown}`;

    expect(rootCommands.match(/\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/root/g)?.length).toBeGreaterThanOrEqual(3);
    expect.soft(rootCommands).not.toContain("NODE_OPTIONS");
    expect.soft(rootCommands).toContain('qemu_project_root="$(pwd -P)"');
    expect.soft(rootCommands).toContain('qemu_service_cwd="$qemu_service_dir"');
    expect.soft(rootCommands).toContain('qemu_owner_script="$qemu_project_root/.dim/qemu-service-owner.mjs"');
    expect.soft(rootCommands).toContain('qemu_service_script="$qemu_project_root/.dim/qemu-service.mjs"');
    const serviceLaunch = rootCommands.slice(rootCommands.indexOf("sudo -n /usr/bin/env -i", rootCommands.indexOf("qemu_root_owner retire")));
    expect.soft(serviceLaunch.indexOf("/usr/bin/env -i")).toBeLessThan(serviceLaunch.indexOf("/bin/sh -c"));
    expect.soft(serviceLaunch).toContain('cd "$1"');
    expect.soft(serviceLaunch).toContain('qemu-service "$qemu_service_cwd"');
    expect(serviceLaunch).toContain("/bin/sh -c");
  });

  it("derives readiness from the structured owner PID rather than the sudo wrapper", async () => {
    const setup = await readFile(setupPath, "utf8");
    const readiness = setup.slice(setup.indexOf("fingerprint="), setup.indexOf("\n  current="));

    expect.soft(readiness).toContain('if(v.state!=="live"||typeof v.pid!=="string")process.exit(1)');
    expect.soft(readiness).toContain('owner_uid="$(awk \'$1 == "Uid:" { print $2; exit }\' "/proc/$owner_pid/status" 2>/dev/null)"');
    expect.soft(readiness).toContain('test "$owner_uid" = 0');
    expect(readiness).not.toContain("ps -o uid=");
    expect(readiness).not.toContain("service_wrapper_pid");
  });
});