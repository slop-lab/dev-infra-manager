import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { runCommand } from "../../web-lifecycle/process.ts";
import { waitForIncusCloudInit } from "./incusReadiness.ts";
import { cleanupIncusForwarding, prepareIncusForwarding } from "./fixtureNetwork.ts";

const [output, image, imageSha, machine] = process.argv.slice(2), repository = resolve(import.meta.dirname, "../../../..");
if (!output?.startsWith("/") || !image?.startsWith("/") || !imageSha || !/^[a-f0-9]{64}$/.test(imageSha)
  || machine !== (await readFile("/etc/machine-id", "utf8")).trim() || userInfo().username !== "dim" || userInfo().uid !== 1001) throw new Error("Incus CI setup requires the exact newly provisioned disposable host identity");
await mkdir(output, { mode: 0o700 });
if (createHash("sha256").update(await readFile(image)).digest("hex") !== imageSha) throw new Error("reviewed Ubuntu VM image digest mismatch");
const run = async (file: string, args: readonly string[]) => (await runCommand(file, args, { cwd: repository, timeoutMs: 30 * 60_000 })).stdout.trim();
const incus = (...args: string[]) => run("sudo", ["incus", "--force-local", "--project", "practical-ci", ...args]);
const sourceSha = await run("git", ["rev-parse", "HEAD"]);
await run("test", ["-c", "/dev/kvm"]);
await run("sudo", ["bash", join(repository, "scripts/checks/lib/install-practical-vm-dependencies-ubuntu.bash")]);
await run("genisoimage", ["--version"]);
await run("test", ["-x", "/usr/bin/mkisofs"]);
const probe = join(output, "kvm-probe");
await writeFile(`${probe}.c`, '#include <fcntl.h>\n#include <linux/kvm.h>\n#include <sys/ioctl.h>\n#include <unistd.h>\nint main(void){int f=open("/dev/kvm",O_RDWR|O_CLOEXEC|O_NOFOLLOW);if(f<0||ioctl(f,KVM_GET_API_VERSION,0)!=12)return 2;int v=ioctl(f,KVM_CREATE_VM,0);if(v<0)return 3;close(v);close(f);return 0;}\n', { mode: 0o600, flag: "wx" });
await run("cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-o", probe, `${probe}.c`]); await run("sudo", [probe]);
await run("sudo", ["incus", "admin", "init", "--minimal"]);
const instances: unknown = JSON.parse(await run("sudo", ["incus", "list", "--all-projects", "--format", "json"]));
if (!Array.isArray(instances) || instances.length !== 0) throw new Error("disposable Incus setup unexpectedly contains workloads");
await run("sudo", ["usermod", "-aG", "incus-admin,kvm,docker", "dim"]);
await run("sudo", ["incus", "project", "create", "practical-ci", "-c", "features.images=true", "-c", "features.profiles=true", "-c", "features.networks=false"]);
await run("sudo", ["incus", "storage", "create", "practical-ci", "dir"]);
await run("sudo", ["incus", "network", "create", "practical-ci", "ipv4.address=10.211.42.1/24", "ipv4.nat=true", "ipv6.address=none"]);
const identity = { machine, sourceSha }, execute = (file: string, args: readonly string[]) => runCommand(file, args, { acceptFailure: true, timeoutMs: 30_000 });
const forwarding = await prepareIncusForwarding(identity, execute);
let prepared = false;
try {
await writeFile(join(output, "forwarding.json"), JSON.stringify(forwarding), { mode: 0o600, flag: "wx" });
await writeFile(join(output, "metadata.yaml"), `architecture: x86_64\ncreation_date: ${Math.floor(Date.now() / 1000)}\nproperties:\n  description: DIM test-only pinned Ubuntu CI seed\n  os: Ubuntu\n  release: noble\n`, { mode: 0o600, flag: "wx" });
await run("tar", ["-cJf", join(output, "metadata.tar.xz"), "-C", output, "metadata.yaml"]);
await incus("image", "import", join(output, "metadata.tar.xz"), image, "--alias", "practical-base");
const cloud = `#cloud-config
users:
  - name: dim
    uid: 1000
    shell: /bin/bash
    lock_passwd: true
    sudo: ALL=(ALL) NOPASSWD:ALL
runcmd:
  - [bash, -ec, 'mkdir -p /run/dim-agent-config; mount -t 9p config /run/dim-agent-config; cd /run/dim-agent-config; ./install.sh']
  # Preserve the builder's current LXD transport; only Incus may claim vsock after the next boot.
  - [systemctl, mask, lxd-agent.service]
  - [bash, -ec, 'apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io git sudo util-linux; usermod -aG docker dim; install -d -o dim -g dim -m 0700 /mnt/dim-tmp; install -d -o dim -g dim -m 0755 /workspace; systemctl enable --now docker']
`;
await incus("init", "practical-base", "practical-ci-image-builder", "--vm", "--storage", "practical-ci", "--network", "practical-ci", "--no-profiles", "--device", "root,size=16GiB", "--config", "limits.cpu=2", "--config", "limits.memory=2GiB", "--config", `cloud-init.user-data=${cloud}`);
await incus("config", "device", "add", "practical-ci-image-builder", "seed", "disk", "source=cloud-init:config");
await incus("start", "practical-ci-image-builder");
const deadline = Date.now() + 15 * 60_000;
for (;;) {
  const ready = await runCommand("sudo", ["incus", "--force-local", "--project", "practical-ci", "exec", "practical-ci-image-builder", "--", "true"], { acceptFailure: true, timeoutMs: 20_000 });
  if (ready.exitCode === 0) break;
  if (Date.now() >= deadline) { await incus("console", "practical-ci-image-builder", "--show-log"); throw new Error("pinned CI VM image agent did not become available"); }
  await new Promise((done) => setTimeout(done, 2000));
}
await waitForIncusCloudInit(deadline);
const nodePin = (await run("bash", ["-c", 'source "$1"; dim_bootstrap_artifact node amd64; printf "%s\\n%s\\n" "$dim_artifact_url" "$dim_artifact_sha256"', "ci-node", join(repository, "scripts/lib/bootstrap-ubuntu-pins.bash")])).split("\n");
const nodeSha = nodePin[1]; if (!nodeSha || !/^[a-f0-9]{64}$/.test(nodeSha)) throw new Error("CI Node pin is invalid");
const nodeArchive = "/home/dim/dim/bootstrap-artifacts/" + nodeSha;
if (createHash("sha256").update(await readFile(nodeArchive)).digest("hex") !== nodeSha) throw new Error("seeded Node artifact digest mismatch");
await incus("file", "push", nodeArchive, "practical-ci-image-builder/tmp/dim-node.tar.xz");
await incus("exec", "practical-ci-image-builder", "--", "bash", "-ec", `printf '%s  %s\\n' '${nodeSha}' /tmp/dim-node.tar.xz | sha256sum -c; mkdir -p /usr/local/lib/dim-ci-node; tar -xJf /tmp/dim-node.tar.xz --strip-components=1 -C /usr/local/lib/dim-ci-node; ln -s /usr/local/lib/dim-ci-node/bin/node /usr/local/bin/node; ln -s /usr/local/lib/dim-ci-node/bin/npm /usr/local/bin/npm; rm /tmp/dim-node.tar.xz; printf '%s\\n' '${sourceSha}' >/etc/dim-ci-image-source; cloud-init clean --logs`);
await incus("stop", "practical-ci-image-builder", "--timeout", "120");
await incus("publish", "practical-ci-image-builder", "--alias", "practical-ready");
const alias: unknown = JSON.parse(await run("sudo", ["incus", "--force-local", "query", "/1.0/images/aliases/practical-ready?project=practical-ci"]));
if (!alias || typeof alias !== "object" || !("target" in alias) || typeof alias.target !== "string" || !/^[a-f0-9]{64}$/.test(alias.target)) throw new Error("prepared image alias has no immutable target");
const published: unknown = JSON.parse(await run("sudo", ["incus", "--force-local", "query", `/1.0/images/${alias.target}?project=practical-ci`]));
if (!published || typeof published !== "object" || !("fingerprint" in published) || typeof published.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(published.fingerprint)
  || !("type" in published) || published.type !== "virtual-machine") throw new Error("prepared Incus image has no immutable VM fingerprint");
await incus("delete", "practical-ci-image-builder");
await run("sudo", ["systemd-run", "--unit=dim-practical-budget", "--property=Delegate=yes", "--property=DelegateSubgroup=supervisor", "--property=CPUAccounting=yes", "--property=MemoryAccounting=yes", "--property=TasksAccounting=yes", "--property=RuntimeMaxSec=10800", "/usr/bin/sleep", "10800"]);
const group = await run("systemctl", ["show", "dim-practical-budget.service", "--property=ControlGroup", "--value"]);
if (!/^\/system\.slice\/dim-practical-budget\.service$/.test(group)) throw new Error("fixture cgroup delegation identity mismatch");
const cgroupRoot = "/sys/fs/cgroup" + group;
const subgroup = await run("systemctl", ["show", "dim-practical-budget.service", "--property=DelegateSubgroup", "--value"]);
const keeper = await run("systemctl", ["show", "dim-practical-budget.service", "--property=MainPID", "--value"]);
if (subgroup !== "supervisor" || !/^[1-9][0-9]*$/.test(keeper)
  || (await readFile(cgroupRoot + "/cgroup.procs", "utf8")).trim() !== ""
  || (await readFile(cgroupRoot + "/supervisor/cgroup.procs", "utf8")).trim() !== keeper) throw new Error("fixture budget keeper must occupy only its delegated supervisor subgroup before enabling controllers");
await run("sudo", ["sh", "-c", 'printf "+cpu +memory +pids\\n" > "$1/cgroup.subtree_control"', "ci-budget", cgroupRoot]);
const budget = join(output, "budget-root.json"); await writeFile(budget, JSON.stringify({ schemaVersion: 1, project: "practical-ci", incusSocket: "/var/lib/incus/unix.socket", cgroupRoot, qemuExecutable: await realpath("/usr/bin/qemu-system-x86_64") }), { mode: 0o600, flag: "wx" });
await run("sudo", ["bash", join(repository, "packages/host/plugins/vm/scripts/install-budget-helper.bash"), await realpath(process.execPath), budget, "dim"]);
await run("sudo", ["systemctl", "daemon-reload"]); await run("sudo", ["systemctl", "restart", "incus"]);
await writeFile(join(output, "host.json"), JSON.stringify({ schemaVersion: 1, project: "practical-ci", storagePool: "practical-ci", network: "practical-ci", guest: { cpuCount: 2, memory: "2GiB", disk: "16GiB" },
  cgroupRoot, budgetHelper: "/usr/local/bin/dim-vm-budget", incusSocket: "/var/lib/incus/unix.socket" }), { mode: 0o600, flag: "wx" });
await writeFile(join(output, "image.json"), JSON.stringify({ schemaVersion: 1, sourceSha, hostMachineId: machine, baseImageSha256: imageSha, imageFingerprint: published.fingerprint, imageType: published.type, nodeSha256: nodeSha,
  kvmProbe: "KVM_CREATE_VM", incusVersion: await run("incus", ["--version"]), nodeVersion: process.versions.node, fixture: "real-incus-kvm", forwarding }), { mode: 0o600, flag: "wx" });
const manager = await runCommand("systemctl", ["is-active", "--quiet", "user@1001.service"], { acceptFailure: true });
if (manager.exitCode === 0) await run("sudo", ["systemctl", "restart", "user@1001.service"]);
console.log(`prepared real Incus/KVM fixture image=${published.fingerprint}; subsequent acceptance must use a refreshed SSH login`);
prepared = true;
} finally { if (!prepared) await cleanupIncusForwarding(forwarding, identity, execute); }
