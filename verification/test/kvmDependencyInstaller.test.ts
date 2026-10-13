import { createHash, randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const installerSource = resolve(workspaceRoot, "verification/scripts/install-kvm-verify-deps-ubuntu.bash");
const nodeInstallerSource = resolve(workspaceRoot, "verification/scripts/lib/install-trusted-qemu-node.bash");
const roots: string[] = [];
const systemTargets: string[] = [];

type Fixture = {
  readonly installer: string;
  readonly log: string;
  readonly target: string;
};

type FixtureOptions = {
  readonly architecture?: "amd64" | "arm64";
  readonly installUser?: string;
};

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-kvm-dependency-installer-test-"));
  roots.push(root);
  const tools = resolve(root, "tools");
  const payload = resolve(root, "node-v24.19.0-linux-x64");
  const archive = resolve(root, "node.tar.xz");
  const installer = resolve(root, "install-kvm-verify-deps-ubuntu.bash");
  const nodeInstaller = resolve(root, "lib/install-trusted-qemu-node.bash");
  const log = resolve(root, "commands.log");
  const target = resolve("/usr/local/lib", `dim-qemu-node-test-${randomUUID()}`);
  systemTargets.push(target);
  await mkdir(resolve(payload, "bin"), { recursive: true });
  await writeFile(resolve(payload, "bin/node"), "#!/usr/bin/env bash\nprintf 'v24.19.0\\n'\n", { mode: 0o755 });
  const packed = spawnSync("tar", ["-C", root, "-cf", archive, "node-v24.19.0-linux-x64"], { encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
  await mkdir(tools);
  await mkdir(resolve(root, "lib"));
  await writeFile(log, "");
  await writeFile(resolve(tools, "sudo"), `#!/usr/bin/env bash
printf 'sudo' >>${JSON.stringify(log)}
printf ' %q' "$@" >>${JSON.stringify(log)}
printf '\n' >>${JSON.stringify(log)}
if [[ "\${1:-}" == -u ]]; then shift 2; fi
exec "$@"
`, { mode: 0o755 });
  await writeFile(resolve(tools, "apt-get"), `#!/usr/bin/env bash
printf 'apt-get' >>${JSON.stringify(log)}
printf ' %q' "$@" >>${JSON.stringify(log)}
printf '\n' >>${JSON.stringify(log)}
`, { mode: 0o755 });
  await writeFile(resolve(tools, "getent"), options.installUser === undefined
    ? "#!/usr/bin/env bash\nprintf 'kvm:x:108:\\n'\n"
    : "#!/usr/bin/env bash\nexit 2\n", { mode: 0o755 });
  await writeFile(resolve(tools, "dpkg"), `#!/usr/bin/env bash\nprintf '${options.architecture ?? "amd64"}\\n'\n`, { mode: 0o755 });
  await writeFile(resolve(tools, "id"), `#!/usr/bin/env bash
if [[ "\${1:-}" == -nG ]]; then printf '${options.installUser ?? "root"}\\n'; else /usr/bin/id "$@"; fi
`, { mode: 0o755 });
  for (const command of ["groupadd", "usermod", "sg"] as const) {
    await writeFile(resolve(tools, command), `#!/usr/bin/env bash
printf '${command}' >>${JSON.stringify(log)}
printf ' %q' "$@" >>${JSON.stringify(log)}
printf '\n' >>${JSON.stringify(log)}
`, { mode: 0o755 });
  }
  for (const command of ["qemu-system-x86_64", "qemu-img", "cloud-localds", "ssh"] as const) {
    await writeFile(resolve(tools, command), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  }
  const helperSource = await readFile(nodeInstallerSource, "utf8");
  await writeFile(nodeInstaller, helperSource
    .replace(/^target=.*$/m, `target=${JSON.stringify(target)}`)
    .replace(/^url=.*$/m, `url=${JSON.stringify(`file://${archive}`)}`)
    .replace("14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647", checksum));
  await chmod(nodeInstaller, 0o755);
  const source = await readFile(installerSource, "utf8");
  await writeFile(installer, source
    .replace(/^script_dir=.*$/m, `script_dir=${JSON.stringify(root)}`)
    .replace(/^node_executable=.*$/m, `node_executable=${JSON.stringify(resolve(target, "bin/node"))}`)
    .replace(/^kvm_device=.*$/m, "kvm_device=/dev/null"));
  await chmod(installer, 0o755);
  return { installer, log, target };
}

function run(installer: string, confirmation: string, installUser = ""): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [installer], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${resolve(installer, "../tools")}:/usr/bin:/bin`, SUDO_USER: installUser },
    input: `${confirmation}\n`,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  await Promise.all(systemTargets.splice(0).map((target) => rm(target, { force: true, recursive: true })));
});

describe("Ubuntu KVM dependency installer", () => {
  it("pins the vetted Node archives without trusting a remote manifest", async () => {
    // Given
    const source = await readFile(nodeInstallerSource, "utf8");

    // When / Then
    expect(source).toContain("node-v${version}-linux-${archive_arch}.tar.xz");
    expect(source).toContain("14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647");
    expect(source).toContain("01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc");
    expect(source).not.toContain("SHASUMS256");
  });

  it("makes no privileged changes when confirmation is not exact", async () => {
    // Given
    const value = await fixture();

    // When
    const result = run(value.installer, "no");

    // Then
    expect(result.status).toBe(1);
    expect(await readFile(value.log, "utf8")).toBe("");
  });

  it("installs a canonical pinned Node without publishing a global PATH entry", async () => {
    // Given
    const value = await fixture();

    // When
    const result = run(value.installer, "yes");

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    const node = resolve(value.target, "bin/node");
    const metadata = await lstat(node);
    expect(metadata).toMatchObject({ uid: 0, gid: 0 });
    expect(metadata.mode & 0o777).toBe(0o755);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect((await readFile(node, "utf8"))).toContain("v24.19.0");
    expect(result.stdout).toContain(`DIM_QEMU_NODE_EXECUTABLE=${value.target}/bin/node`);
    expect(await readFile(value.log, "utf8")).not.toContain("/usr/local/bin/node");
  });

  it("refuses and preserves a foreign existing target", async () => {
    // Given
    const value = await fixture();
    await mkdir(value.target);
    await writeFile(resolve(value.target, "foreign"), "preserve\n");

    // When
    const result = run(value.installer, "yes");

    // Then
    expect(result.status).not.toBe(0);
    expect(await readFile(resolve(value.target, "foreign"), "utf8")).toBe("preserve\n");
  });

  it("rejects a writable existing ancestor before executing its Node file", async () => {
    // Given
    const value = await fixture();
    const sentinel = resolve(value.target, "executed");
    await mkdir(resolve(value.target, "bin"), { recursive: true });
    await chmod(value.target, 0o777);
    await writeFile(resolve(value.target, "bin/node"), `#!/usr/bin/env bash
touch ${JSON.stringify(sentinel)}
printf 'v24.19.0\\n'
`, { mode: 0o755 });

    // When
    const result = run(value.installer, "yes");

    // Then
    expect(result.status).not.toBe(0);
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an arm64 host before confirmation or privileged changes", async () => {
    // Given
    const value = await fixture({ architecture: "arm64" });

    // When
    const result = run(value.installer, "yes");

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unsupported KVM host architecture");
    expect(await readFile(value.log, "utf8")).toBe("");
  });

  it("provisions and verifies KVM group access for the invoking non-root user", async () => {
    // Given
    const value = await fixture({ installUser: "operator" });

    // When
    const result = run(value.installer, "yes", "operator");

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    const commands = await readFile(value.log, "utf8");
    expect(commands).toContain("sudo groupadd --system kvm");
    expect(commands).toContain("sudo usermod -aG kvm operator");
    expect(commands).toContain("sudo -u operator sg kvm -c");
    expect(result.stdout).toContain("newgrp kvm");
  });
});
