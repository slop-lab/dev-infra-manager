import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, lstat, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { ContainerWorkspaceRuntime, WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { hostPlugin } from "../../../../packages/host/plugins/execution-worker/src/index.js";
import { ProcessRunner } from "../../../../packages/host/core/src/index.js";
import { prepareHardwareSsh, publishHardwareSsh, hardwareSshInfo } from "../../../../packages/host/plugins/execution-worker/src/hardwareSsh.js";
import { ownershipLabels } from "../../../../packages/host/plugins/execution-worker/src/backends/containers.js";
import { NativeHostPrivateRoot } from "../../../../packages/host/plugins/execution-worker/src/private-root.js";
import { qemuContainerArguments } from "../../../../packages/host/plugins/execution-worker/src/backends/qemu.js";
import { assignment, grant, event } from "../../../contracts/ci/executionFixture.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-hardware-ssh-"));
  const a = { ...assignment(), event: event("practical", "qemu") }, g = grant(a);
  const parent = join(directory, a.slotId), rootId = randomUUID(), root = join(parent, `work-${rootId}`), hardware = join(root, "hardware");
  await mkdir(hardware, { recursive: true, mode: 0o700 });
  const stat = await lstat(root, { bigint: true });
  const config = join(directory, "worker.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, endpoint: "http://127.0.0.1:8080", workerId: a.workerId, generationId: a.generationId, token: "t".repeat(64), nativeGitEndpoint: "http://127.0.0.1:8081", gitExecutable: "/usr/bin/git", stateDirectory: directory, slots: [{ id: a.slotId, runtime: "vm" }] }), { mode: 0o600 });
  await writeFile(join(parent, "execution.json"), JSON.stringify({ requestId: a.requestId, assignment: { ...a, grant: g }, root: { schemaVersion: 1, state: "created", rootId, device: stat.dev.toString(), inode: stat.ino.toString() } }), { mode: 0o600 });
  await writeFile(join(root, ".dim-native-ordinary-owner.json"), JSON.stringify({ schemaVersion: 1, rootId, claimId: a.id }), { mode: 0o600 });
  const inspect = { Id: "a".repeat(64), State: { Running: true }, Config: { Labels: Object.fromEntries(ownershipLabels(g, "qemu").map(s => { const i = s.indexOf("="); return [s.slice(0, i), s.slice(i + 1)]; })) }, NetworkSettings: { Ports: { "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "40222" }] } } };
  const runner = new ProcessRunner();
  runner.run = async (command, args) => { expect(command).toBe("docker"); expect(args.slice(0, 2)).toEqual(["container", "inspect"]); return { command, args, exitCode: 0, stdout: JSON.stringify([inspect]), stderr: "" }; };
  return { directory, a, g, hardware, config, runner, inspect };
}
it("generates independent fresh keys, pins guest host identity, and discovers only the active owned loopback endpoint", async () => {
  const f = await fixture();
  try {
    await prepareHardwareSsh(f.hardware, new ProcessRunner(), AbortSignal.timeout(5000));
    const operator = await readFile(join(f.hardware, "operator-key")), server = await readFile(join(f.hardware, "guest-host-key"));
    expect(operator.equals(server)).toBe(false);
    expect((await lstat(join(f.hardware, "operator-key"))).mode & 0o777).toBe(0o600);
    await publishHardwareSsh(f.hardware, f.g, f.runner, AbortSignal.timeout(5000));
    const info = await hardwareSshInfo(f.config, f.a.id, f.runner, AbortSignal.timeout(5000));
    expect(info.port).toBe(40222); expect(JSON.stringify(info)).not.toContain("t".repeat(64));
    const store = new WorkspaceStore(join(f.directory, "unused-host-store"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await hostPlugin.run!(["execution", "worker", "ssh-info", "--config", f.config, "--execution", f.a.id, "--json"], {
        runner: f.runner, cleanupRunner: f.runner, store, stateRoot: store.root, signal: AbortSignal.timeout(5000),
        service: new WorkspaceService(store, new ContainerWorkspaceRuntime(f.runner), async () => { throw Error("unexpected acquisition"); })
      });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(info);
    } finally { log.mockRestore(); }
    const expanded = execFileSync("ssh", ["-G", "-F", info.sshConfig, "dim-verification"], { encoding: "utf8" });
    expect(expanded).toContain("hostname 127.0.0.1"); expect(expanded).toContain("port 40222"); expect(expanded).toContain("stricthostkeychecking true"); expect(expanded).toContain("forwardagent no");
    expect(expanded).toContain("globalknownhostsfile /dev/null"); expect(expanded).toContain("hostkeyalgorithms ssh-ed25519"); expect(expanded).toContain("updatehostkeys false");
    expect(await readFile(join(f.hardware, "known_hosts"), "utf8")).toContain(await readFile(join(f.hardware, "guest-host-key.pub"), "utf8"));
    await expect(hardwareSshInfo(f.config, randomUUID(), f.runner, AbortSignal.timeout(5000))).rejects.toThrow("no active");
    f.inspect.Id = "b".repeat(64);
    await expect(hardwareSshInfo(f.config, f.a.id, f.runner, AbortSignal.timeout(5000))).rejects.toThrow("container identity changed");
    f.inspect.Id = "a".repeat(64);
    const another = join(f.directory, "another"); await mkdir(another, { mode: 0o700 });
    await prepareHardwareSsh(another, new ProcessRunner(), AbortSignal.timeout(5000));
    expect((await readFile(join(another, "operator-key"))).equals(operator)).toBe(false);
    // Existing exact attempt-root deletion also removes both keys and SSH configuration.
    f.inspect.State.Running = false;
    const journal = JSON.parse(await readFile(join(f.directory, f.a.slotId, "execution.json"), "utf8"));
    const owned = new NativeHostPrivateRoot(join(f.directory, f.a.slotId), journal.root);
    expect(await owned.cleanup(f.a.id)).toBe(true);
    await expect(hardwareSshInfo(f.config, f.a.id, f.runner, AbortSignal.timeout(5000))).rejects.toThrow();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
it.each(["public-port", "foreign-owner", "stopped"])("rejects %s rather than exposing another endpoint", async mode => {
  const f = await fixture();
  try {
    await prepareHardwareSsh(f.hardware, new ProcessRunner(), AbortSignal.timeout(5000));
    if (mode === "public-port") f.inspect.NetworkSettings.Ports["2222/tcp"][0]!.HostIp = "0.0.0.0";
    if (mode === "foreign-owner") f.inspect.Config.Labels["dim.attempt"] = randomUUID();
    if (mode === "stopped") f.inspect.State.Running = false;
    await expect(publishHardwareSsh(f.hardware, f.g, f.runner, AbortSignal.timeout(5000))).rejects.toThrow();
    await expect(readFile(join(f.hardware, "ssh_config"))).rejects.toThrow();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
it("rejects unsafe private input and never publishes SSH for ordinary QEMU", async () => {
  const f = await fixture();
  try {
    await symlink(f.config, join(f.directory, "linked-config"));
    await expect(hardwareSshInfo(join(f.directory, "linked-config"), f.a.id, f.runner, AbortSignal.timeout(5000))).rejects.toThrow("invalid private execution worker configuration");
    const args = qemuContainerArguments({ grant: f.g, root: "/private/owned" }, { uid: 1000, gid: 1000, kvmGroup: 108 });
    expect(args).not.toContain("--publish");
    const hardware = qemuContainerArguments({ grant: f.g, root: "/private/owned" }, { uid: 1000, gid: 1000, kvmGroup: 108 }, undefined, true);
    expect(hardware).toContain("127.0.0.1::2222/tcp");
    expect(() => qemuContainerArguments({ grant: f.g, root: "/private/owned" }, { uid: 1000, gid: 1000, kvmGroup: 108 }, { network: "host", blockedHostnames: [], dockerDaemonConfig: "{}" }, true)).toThrow("isolated bridge");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it("passes only the public operator key and this guest's fresh server identity to cloud-init before bootstrap", async () => {
  const path = new URL("../../../../packages/host/plugins/execution-worker/src/ubuntu-hardware-runner-assets/supervisor.ts", import.meta.url);
  const source = stripTypeScriptTypes((await readFile(path, "utf8")).replace(/^import .*;$/gm, ""));
  const files = new Map<string, string>(), reads: string[] = [];
  let qemu: readonly string[] = [];
  const image = "registry.example/hardware@sha256:" + "a".repeat(64);
  runInNewContext(source, {
    process: { argv: ["node", "supervisor", "/run/dim/job/descriptor.json", "/run/dim/job/script", "/run/dim/workspace", image, "4", String(20 * 1024 ** 3), "8192"], getuid: () => 1000, umask: () => {}, on: () => {} },
    Buffer, join,
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o700 }),
    statfsSync: () => ({ type: 1n, bavail: 100n * 1024n ** 3n, bsize: 1n }),
    readFileSync: (name: string) => {
      reads.push(name);
      if (name.endsWith("descriptor.json")) return JSON.stringify({ runnerBaseImage: image, jobImage: image, bounds: { cpu: "4", memoryBytes: String(20 * 1024 ** 3), pids: "8192" } });
      if (name.endsWith("operator-key.pub")) return "ssh-ed25519 AAAA operator-public\n";
      if (name.endsWith("guest-host-key.pub")) return "ssh-ed25519 BBBB guest-public\n";
      if (name.endsWith("guest-host-key")) return "PRIVATE-GUEST-HOST-KEY\n";
      if (name === "/opt/dim/guest-run.bash") return "#!/bin/bash\necho public-bootstrap";
      throw Error("unexpected private read");
    },
    writeFileSync: (name: string, bytes: string) => { files.set(name, bytes); },
    spawnSync: () => ({ status: 0 }),
    spawn: (file: string, args: string[]) => { expect(file).toBe("qemu-system-x86_64"); qemu = args; return { once: () => {}, kill: () => {} }; }
  });
  const cloud = JSON.parse(files.get("/run/dim/hardware/user-data")!.replace("#cloud-config\n", ""));
  expect(cloud.users[0].ssh_authorized_keys).toEqual(["ssh-ed25519 AAAA operator-public"]);
  expect(cloud.ssh_keys.ed25519_private).toBe("PRIVATE-GUEST-HOST-KEY\n");
  expect(cloud.ssh_deletekeys).toBe(true); expect(cloud.ssh_pwauth).toBe(false); expect(cloud.disable_root).toBe(true);
  expect(reads).not.toContain("/run/dim/hardware/operator-key");
  expect(qemu).toContain("user,id=jobnet,hostfwd=tcp:0.0.0.0:2222-:22");
  expect(qemu.filter(value => value.startsWith("local,id="))).not.toContain(expect.stringContaining("hardware"));
});
it.each(["generation", "terminal", "marker", "inode"])("rejects stale %s identity before returning a connection", async mode => {
  const f = await fixture();
  try {
    await prepareHardwareSsh(f.hardware, new ProcessRunner(), AbortSignal.timeout(5000));
    await publishHardwareSsh(f.hardware, f.g, f.runner, AbortSignal.timeout(5000));
    const journalPath = join(f.directory, f.a.slotId, "execution.json"), journal = JSON.parse(await readFile(journalPath, "utf8"));
    if (mode === "generation") journal.assignment.generationId = "b".repeat(64);
    if (mode === "terminal") journal.assignment.phase = "finished";
    if (mode === "inode") journal.root.inode = "0";
    if (mode === "marker") await writeFile(join(f.hardware, "..", ".dim-native-ordinary-owner.json"), JSON.stringify({ schemaVersion: 1, rootId: journal.root.rootId, claimId: randomUUID() }));
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(hardwareSshInfo(f.config, f.a.id, f.runner, AbortSignal.timeout(5000))).rejects.toThrow();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it("does not expose private configuration fragments on malformed JSON", async () => {
  const f = await fixture();
  try {
    await writeFile(f.config, '{"token":"private-config-secret" INVALID');
    await expect(hardwareSshInfo(f.config, f.a.id, f.runner, AbortSignal.timeout(5000))).rejects.toThrow(/^invalid private execution worker configuration$/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
