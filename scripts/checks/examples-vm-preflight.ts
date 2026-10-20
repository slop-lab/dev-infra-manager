import { spawnSync } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";

const help = `Usage: node scripts/checks/examples-vm-preflight.ts [--json]

Check the environment that will launch the two independent KVM VMs.
Run inside the DIM workspace, then: just verify examples-vm

On the selected DIM host, prepare an explicitly KVM-enabled workspace:
  dim installer install plugin @slop-lab/dim-host-plugin-kvm@0.10.0
  dim kvm configure
  dim create SOURCE dim-verify --runtime container-kvm --cpus 4 --memory 12g --pids 8192

Inside that workspace, install the verification tools if missing:
  bash scripts/dev.bash setup-vm
This selects Alpine apk (the default workspace image) or Ubuntu/Debian apt.

Use Node.js 24 or 26 and Just. The checkout must be clean and committed before
acceptance. KVM is explicit host authority; a repository cannot grant it.
This check creates and closes an empty KVM VM; it does not boot a guest.
`;
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(help);
} else if (args.length > 1 || args.some((arg) => arg !== "--json")) {
  process.stderr.write(help);
  process.exitCode = 2;
} else {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add("architecture", process.arch === "x64" && process.platform === "linux", `${process.platform}/${process.arch}; requires Linux x86-64`);
  add("Node.js", /^(24|26)\./.test(process.versions.node), process.versions.node);
  for (const command of ["qemu-system-x86_64", "qemu-img", "cloud-localds", "python3", "ssh", "scp", "ssh-keygen", "curl", "git", "timeout", "sha256sum", "just"]) {
    const result = spawnSync("sh", ["-c", 'command -v "$1"', "examples-vm-tool", command], { encoding: "utf8", timeout: 5_000 });
    add(command, result.status === 0, result.status === 0 ? result.stdout.trim() : "missing; see --help for workspace tool setup");
  }
  const probe = spawnSync("python3", ["-c", `import os, fcntl, stat
fd = os.open('/dev/kvm', os.O_RDWR | os.O_NOFOLLOW)
try:
    assert stat.S_ISCHR(os.fstat(fd).st_mode), '/dev/kvm is not a character device'
    assert fcntl.ioctl(fd, 0xae00, 0) == 12, 'unsupported KVM API'
    vm = fcntl.ioctl(fd, 0xae01, 0)
    os.close(vm)
    print('KVM API 12; KVM_CREATE_VM succeeded')
finally:
    os.close(fd)
`], { encoding: "utf8", timeout: 10_000 });
  add("KVM acceleration", probe.status === 0, probe.status === 0 ? probe.stdout.trim()
    : `${(probe.stderr || probe.error?.message || "KVM probe failed").trim().split("\n").at(-1)}\nRun 'dim kvm doctor' on the selected host; use --runtime container-kvm. Host KVM availability alone does not expose it inside a workspace.`);
  const constrained = process.constrainedMemory();
  let memory = constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
  // Sysbox virtualizes the cgroup view: libuv may report no constraint while
  // the container's mounted cgroup root still exposes its real finite budget.
  try {
    const mountedLimit = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (/^[1-9][0-9]*$/.test(mountedLimit)) memory = Math.min(memory, Number(mountedLimit));
  } catch { /* Non-cgroup-v2 hosts still use libuv's detected constraint. */ }
  add("memory budget", memory >= 8 * 1024 ** 3, `${(memory / 1024 ** 3).toFixed(1)} GiB; at least 8 GiB required, 12 GiB recommended for the two VMs`);
  try {
    const disk = statfsSync(tmpdir());
    const free = disk.bavail * disk.bsize;
    add("temporary disk", free >= 24 * 1024 ** 3, `${tmpdir()}: ${(free / 1024 ** 3).toFixed(1)} GiB available; at least 24 GiB required`);
  } catch (error) { add("temporary disk", false, error instanceof Error ? error.message : String(error)); }
  if (args[0] === "--json") process.stdout.write(`${JSON.stringify(checks)}\n`);
  else {
    for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "FAIL"}\t${check.name}\t${check.detail}\n`);
    process.stdout.write(checks.every((check) => check.ok)
      ? "Ready: just verify examples-vm (separate control-plane and host VMs; disposable resources only).\n"
      : "Unavailable: fix the failed checks above. Setup: node scripts/checks/examples-vm-preflight.ts --help\n");
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 2;
}
