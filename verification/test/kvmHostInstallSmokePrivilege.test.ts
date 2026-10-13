import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const smokePath = resolve(workspaceRoot, "verification/scripts/kvm-host-install-smoke.bash");
const roots: string[] = [];
const stagedModules = [
  "qemu-input-handoff.mjs", "qemu-owner-record.mjs", "qemu-process-group.mjs", "qemu-run-finalization.mjs",
  "qemu-service-artifacts.mjs", "qemu-service-filesystem.mjs", "qemu-service-http.mjs", "qemu-service-owner.mjs",
  "qemu-service-startup.mjs", "qemu-service.mjs", "qemu-snapshot.mjs",
] as const;

type Fixture = {
  readonly clientRecord: string;
  readonly movedServiceDirectory: string;
  readonly projectRoot: string;
  readonly root: string;
  readonly serviceDirectory: string;
  readonly smoke: string;
  readonly sudoRecord: string;
};

async function fixture(replaceDuringClient = false, mutateCheckoutBeforeServiceLaunch = false): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-kvm-host-smoke-test-"));
  roots.push(root);
  await chmod(root, 0o755);
  const tools = resolve(root, "tools");
  const projectRoot = resolve(root, "project");
  const projectDim = resolve(projectRoot, ".dim");
  const serviceDirectory = resolve(root, "service");
  const sudoRecord = resolve(root, "sudo.log");
  const clientRecord = resolve(root, "client.log");
  const movedServiceDirectory = resolve(root, "service-owned");
  const smoke = resolve(root, "kvm-host-install-smoke.bash");
  const launcher = resolve(root, "launcher.bash");
  await mkdir(tools);
  await mkdir(projectDim, { recursive: true });
  await Promise.all([...stagedModules, "qemu-client.mjs"].map(async (module) => {
    await copyFile(resolve(workspaceRoot, ".dim", module), resolve(projectDim, module));
  }));
  await writeFile(clientRecord, "");
  await chmod(clientRecord, 0o666);
  await writeFile(resolve(tools, "sudo"), `#!/usr/bin/env bash
printf '%q ' "$@" >>${JSON.stringify(sudoRecord)}
printf '\n' >>${JSON.stringify(sudoRecord)}
[[ "\${1:-}" != -n ]] || shift
for argument in "$@"; do
  if [[ "$argument" == qemu-service && ${mutateCheckoutBeforeServiceLaunch ? "true" : "false"} == true ]]; then
    printf 'throw new Error("mutable checkout module executed")\n' >${JSON.stringify(resolve(projectDim, "qemu-service-http.mjs"))}
  fi
done
exec "$@"
`);
  await chmod(resolve(tools, "sudo"), 0o700);
  await writeFile(launcher, `#!/usr/bin/env bash
printf 'uid=%s service=%s args=' "$(id -u)" "$(stat -Lc '%u:%g:%a' -- "$(dirname "$0")")" >>${JSON.stringify(clientRecord)}
printf '%q ' "$@" >>${JSON.stringify(clientRecord)}
printf '\n' >>${JSON.stringify(clientRecord)}
printf 'module=%s\n' "$(stat -Lc '%u:%g:%a' -- "$(dirname "$0")/modules/qemu-service.mjs")" >>${JSON.stringify(clientRecord)}
if [[ "\${DIM_QEMU_INPUT_SNAPSHOTS_JSON:-[]}" != '[]' ]]; then
  ${JSON.stringify(process.execPath)} --input-type=commonjs -e '
    const inputs = JSON.parse(process.env.DIM_QEMU_INPUT_SNAPSHOTS_JSON ?? "[]");
    for (const input of inputs) {
      const metadata = require("node:fs").statSync(input.path);
      process.stdout.write("handoff=" + metadata.uid + ":" + metadata.gid + ":" + (metadata.mode & 0o777).toString(8) + "\\n");
      process.stdout.write(require("node:fs").readFileSync(input.path + "/payload.txt", "utf8"));
    }
  ' >>${JSON.stringify(clientRecord)}
fi
`);
  await chmod(launcher, 0o700);
  const client = resolve(root, "qemu-client.mjs");
  if (replaceDuringClient) {
    await writeFile(client, `import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const serviceDirectory = dirname(process.env.DIM_QEMU_VERIFICATION_SOCKET);
await rename(serviceDirectory, ${JSON.stringify(movedServiceDirectory)});
await mkdir(serviceDirectory, { mode: 0o755 });
await writeFile(serviceDirectory + "/foreign", "preserve\\n");
process.exitCode = 1;
`);
  }
  const source = await readFile(smokePath, "utf8");
  await writeFile(smoke, source
    .replace(/^repository_root=.*$/m, `repository_root=${JSON.stringify(projectRoot)}`)
    .replace(/^client=.*$/m, `client=${JSON.stringify(replaceDuringClient ? client : resolve(projectDim, "qemu-client.mjs"))}`)
    .replace(/^invoking_uid=.*$/m, "invoking_uid=1000")
    .replace(/^invoking_gid=.*$/m, "invoking_gid=1000")
    .replace(/^sudo_command=.*$/m, `sudo_command=${JSON.stringify(resolve(tools, "sudo"))}`)
    .replace(/^service_dir=.*$/m, `service_dir=${JSON.stringify(serviceDirectory)}`)
    .replace(/^source_root=.*$/m, `source_root=${JSON.stringify(root)}`));
  await chmod(smoke, 0o700);
  return { clientRecord, movedServiceDirectory, projectRoot, root, serviceDirectory, smoke, sudoRecord };
}

function run(fixtureValue: Fixture, ...arguments_: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [fixtureValue.smoke, ...arguments_], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${resolve(fixtureValue.root, "tools")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      DIM_QEMU_TRUSTED_LAUNCHER: resolve(fixtureValue.root, "launcher.bash"),
    },
    timeout: 20_000,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("KVM host-install smoke privilege boundary", () => {
  it("extracts host-owned inputs as the fixed guest user rather than preserving the host UID", async () => {
    const script = await readFile(resolve(workspaceRoot, ".dim/qemu-verify.bash"), "utf8");
    expect(script).toContain("sudo install -d -o dim -g dim -m 0700 /mnt/dim-inputs");
    expect(script).toContain("tar -C /mnt/dim-inputs --strip-components=1 --no-same-owner -xzf -");
    expect(script).not.toContain("sudo tar -C /mnt -xzf -");

    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-input-tar-test-"));
    roots.push(root);
    const source = resolve(root, "source", "dim-inputs", "fixture", "nested");
    const destination = resolve(root, "guest-inputs");
    const archive = resolve(root, "inputs.tar.gz");
    await mkdir(source, { recursive: true });
    await mkdir(destination);
    await writeFile(resolve(source, "payload"), "guest-readable\n", { mode: 0o400 });
    await chmod(source, 0o500);
    await symlink("payload", resolve(source, "link"));
    const sourceRoot = resolve(root, "source");
    const archivedUid = process.getuid?.() === 1000 ? 1001 : 1000;
    const packed = spawnSync("tar", ["-C", sourceRoot, `--owner=${archivedUid}`, `--group=${archivedUid}`,
      "-czf", archive, "dim-inputs"], { encoding: "utf8" });
    expect(packed.status, packed.stderr).toBe(0);
    const extracted = spawnSync("tar", ["-C", destination, "--strip-components=1", "--no-same-owner",
      "-xzf", archive], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    const payload = resolve(destination, "fixture", "nested", "payload");
    expect((await lstat(payload)).uid).toBe(process.getuid?.());
    expect((await lstat(payload)).mode & 0o777).toBe(0o400);
    expect(await readFile(payload, "utf8")).toBe("guest-readable\n");
    expect((await lstat(resolve(destination, "fixture", "nested", "link"))).isSymbolicLink()).toBe(true);
  });

  it("executes the root service and owner only from the staged closure after checkout mutation", async () => {
    // Given
    const fixtureValue = await fixture(false, true);

    // When
    const result = run(fixtureValue);

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    const sudoCalls = await readFile(fixtureValue.sudoRecord, "utf8");
    const rootModuleCalls = sudoCalls.split("\n")
      .filter((call) => call.includes("qemu-service") && !call.includes("/usr/bin/install"));
    expect(rootModuleCalls.some((call) => call.includes(`${fixtureValue.serviceDirectory}/modules/qemu-service.mjs`))).toBe(true);
    expect(rootModuleCalls.some((call) => call.includes(`${fixtureValue.serviceDirectory}/modules/qemu-service-owner.mjs`))).toBe(true);
    expect(rootModuleCalls.every((call) => !call.includes(`${fixtureValue.projectRoot}/.dim/qemu-`))).toBe(true);
    const stagedDestinations = sudoCalls.split("\n")
      .filter((call) => call.includes("/usr/bin/install") && call.includes("/modules/qemu-"))
      .map((call) => call.trim().split("/").at(-1));
    expect(stagedDestinations).toEqual(stagedModules);
    expect(await readFile(fixtureValue.clientRecord, "utf8")).toContain("module=0:0:444");
  }, 25_000);

  it("makes validated input bytes readable to the invoking non-root gate", async () => {
    // Given
    const fixtureValue = await fixture();
    const input = resolve(fixtureValue.root, "input");
    await mkdir(input, { mode: 0o755 });
    await writeFile(resolve(input, "payload.txt"), "handoff-readable\n", { mode: 0o644 });

    // When
    const result = run(fixtureValue, "--input", `fixture=${input}`);

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    expect(await readFile(fixtureValue.clientRecord, "utf8")).toContain("handoff=1000:1000:500\nhandoff-readable\n");
  }, 25_000);

  it("uses narrow privileged commands only for the root service and keeps the client outside sudo", async () => {
    // Given
    const fixtureValue = await fixture();

    // When
    const result = run(fixtureValue, "--verbose");

    // Then
    expect(result, result.stderr).toMatchObject({ status: 0 });
    const sudoCalls = await readFile(fixtureValue.sudoRecord, "utf8");
    expect.soft(sudoCalls).toContain("-n /usr/bin/true");
    expect.soft(sudoCalls).toContain("qemu-service-directory");
    expect.soft(sudoCalls).toContain("/usr/bin/mkdir");
    expect.soft(sudoCalls).toContain("/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root");
    expect.soft(sudoCalls).toContain("qemu-service.mjs");
    expect.soft(sudoCalls).toContain("retire-exact");
    expect.soft(sudoCalls).toContain("qemu-service-directory-cleanup");
    expect(sudoCalls).not.toContain("qemu-client.mjs");
    const serviceLaunch = sudoCalls.split("\n")
      .find((call) => call.includes("qemu-service.mjs") && !call.includes("/usr/bin/install"));
    expect(serviceLaunch).toContain("DIM_QEMU_SOURCE_ROOT=");
    expect(serviceLaunch).toContain("DIM_QEMU_LAUNCHER=");
    expect(serviceLaunch).toContain("DIM_KVM_IMAGE_CACHE=");
    expect(serviceLaunch).toContain("DIM_QEMU_SERVICE_SOCKET=");
    expect(await readFile(fixtureValue.clientRecord, "utf8")).toContain("uid=1000 service=0:0:755 args=--verbose");
  }, 25_000);

  it("refuses a foreign pre-existing service directory without mutation", async () => {
    // Given
    const fixtureValue = await fixture();
    await mkdir(fixtureValue.serviceDirectory);
    const sentinel = resolve(fixtureValue.serviceDirectory, "foreign");
    await writeFile(sentinel, "preserve\n");

    // When
    const result = run(fixtureValue);

    // Then
    expect(result.status).not.toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("preserve\n");
    await expect(readFile(fixtureValue.sudoRecord, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails the noninteractive sudo preflight instead of prompting", async () => {
    // Given
    const fixtureValue = await fixture();
    await writeFile(resolve(fixtureValue.root, "tools/sudo"), "#!/usr/bin/env bash\nexit 1\n");
    await chmod(resolve(fixtureValue.root, "tools/sudo"), 0o700);

    // When
    const result = run(fixtureValue);

    // Then
    expect(result).toMatchObject({ status: 2 });
    expect(result.stderr).toContain("sudo -n preflight failed");
  });

  it("refuses a service-directory symlink without touching its target", async () => {
    // Given
    const fixtureValue = await fixture();
    const target = resolve(fixtureValue.root, "foreign-target");
    await mkdir(target);
    await writeFile(resolve(target, "foreign"), "preserve\n");
    await symlink(target, fixtureValue.serviceDirectory);

    // When
    const result = run(fixtureValue);

    // Then
    expect(result.status).not.toBe(0);
    expect((await lstat(fixtureValue.serviceDirectory)).isSymbolicLink()).toBe(true);
    expect(await readFile(resolve(target, "foreign"), "utf8")).toBe("preserve\n");
    await expect(readFile(fixtureValue.sudoRecord, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops only the exact service PID and preserves a replacement directory during cleanup", async () => {
    // Given
    const fixtureValue = await fixture(true);

    // When
    const result = run(fixtureValue);

    // Then
    expect(result.status).not.toBe(0);
    const ownerRecord: unknown = JSON.parse(await readFile(resolve(fixtureValue.movedServiceDirectory, "service-owner.json"), "utf8"));
    if (typeof ownerRecord !== "object" || ownerRecord === null || !("pid" in ownerRecord)
      || typeof ownerRecord.pid !== "string") throw new TypeError("fixture owner PID is invalid");
    expect(() => process.kill(Number(ownerRecord.pid), 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    expect(await readFile(resolve(fixtureValue.serviceDirectory, "foreign"), "utf8")).toBe("preserve\n");
    expect((await lstat(fixtureValue.serviceDirectory)).isDirectory()).toBe(true);
  }, 25_000);
});
