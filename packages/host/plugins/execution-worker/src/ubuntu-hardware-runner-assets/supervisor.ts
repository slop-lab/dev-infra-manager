/** Bootstrap runs inside the trusted rootless supervisor, before guest tools. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, lstatSync, writeFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
process.umask(0o077);
const [descriptor, script, workspace, image, cpu, memory, pids] = process.argv.slice(2);
if (process.argv.length !== 9 || descriptor !== "/run/dim/job/descriptor.json" || script !== "/run/dim/job/script"
  || workspace !== "/run/dim/workspace" || !image || !/@sha256:[a-f0-9]{64}$/.test(image)
  || !cpu || !memory || !pids || ![cpu, memory, pids].every(value => /^[1-9][0-9]*$/.test(value))) throw new Error("invalid Ubuntu hardware invocation");
const spec: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
if (!spec || typeof spec !== "object" || !("runnerBaseImage" in spec) || !("jobImage" in spec)
  || spec.runnerBaseImage !== image || spec.jobImage !== image || Number(cpu) < 4 || BigInt(memory) < 20n * 1024n ** 3n) throw new Error("hardware image/resource binding mismatch");
const directory = "/run/dim/hardware", metadata = lstatSync(directory), disk = statfsSync(directory, { bigint: true });
if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)
  || disk.type === 0x01021994n || disk.bavail * disk.bsize < 80n * 1024n ** 3n) throw new Error("hardware scratch must be private and disk-backed with 80 GiB free");
const run = (file: string, args: string[]) => { const result = spawnSync(file, args, { stdio: "inherit" }); if (result.status !== 0) throw new Error(`hardware bootstrap command failed: ${file}`); };
const root = join(directory, "root.qcow2"), scratch = join(directory, "scratch.raw"), seed = join(directory, "seed.img");
run("qemu-img", ["create", "-f", "qcow2", "-F", "qcow2", "-b", "/opt/dim/ubuntu.qcow2", root, "24G"]);
run("qemu-img", ["create", "-f", "raw", scratch, "64G"]);
const bootstrap = readFileSync("/opt/dim/guest-run.bash", "utf8").replaceAll("@DIM_PIDS@", pids);
const cloud = { users: [{ name: "dim", uid: 1000, groups: ["sudo"], sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true }],
  ssh_pwauth: false, disable_root: true, package_update: true,
  packages: ["python3", "git", "curl", "ca-certificates", "build-essential", "qemu-system-x86", "qemu-utils", "cloud-image-utils", "openssh-client", "xz-utils", "libatomic1"],
  write_files: [{ path: "/usr/local/sbin/dim-hardware-job", permissions: "0700", encoding: "b64", content: Buffer.from(bootstrap).toString("base64") }],
  runcmd: [["/bin/bash", "/usr/local/sbin/dim-hardware-job"]] };
writeFileSync(join(directory, "user-data"), "#cloud-config\n" + JSON.stringify(cloud), { flag: "wx", mode: 0o600 });
writeFileSync(join(directory, "meta-data"), "instance-id: dim-hardware-job\nlocal-hostname: dim-hardware-job\n", { flag: "wx", mode: 0o600 });
run("cloud-localds", [seed, join(directory, "user-data"), join(directory, "meta-data")]);
const child = spawn("qemu-system-x86_64", ["-machine", "q35,accel=kvm", "-cpu", "host", "-smp", cpu, "-m", String(BigInt(memory) / 1048576n),
  "-nodefaults", "-no-reboot", "-display", "none", "-serial", "stdio", "-device", "virtio-rng-pci", "-device", "isa-debug-exit,iobase=0xf4,iosize=0x04",
  "-chardev", `file,id=result,path=${join(directory, "exit-status")}`, "-device", "virtio-serial-pci", "-device", "virtserialport,chardev=result,name=dim.result",
  "-drive", `file=${root},if=virtio,format=qcow2`, "-drive", `file=${scratch},if=virtio,format=raw`, "-drive", `file=${seed},if=virtio,format=raw,readonly=on`,
  "-netdev", "user,id=jobnet", "-device", "virtio-net-pci,netdev=jobnet",
  "-fsdev", "local,id=job,path=/run/dim/job,security_model=none,readonly=on", "-device", "virtio-9p-pci,fsdev=job,mount_tag=job",
  "-fsdev", "local,id=tools,path=/opt/dim/tools,security_model=none,readonly=on", "-device", "virtio-9p-pci,fsdev=tools,mount_tag=tools",
  "-fsdev", "local,id=workspace,path=/run/dim/workspace,security_model=mapped-xattr", "-device", "virtio-9p-pci,fsdev=workspace,mount_tag=workspace"], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
child.once("error", () => { process.exitCode = 1; });
child.once("close", code => {
  try {
    const result = join(directory, "exit-status"), info = lstatSync(result);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > 4) throw new Error("invalid hardware exit receipt");
    const text = readFileSync(result, "ascii"), status = Number(text.trim());
    if (!/^(?:0|[1-9][0-9]{0,2})\n$/.test(text) || status > 255 || code !== (status === 0 ? 85 : 87)) throw new Error("hardware exit receipt disagrees with VM termination");
    process.exitCode = status;
  } catch { process.exitCode = 1; }
});
