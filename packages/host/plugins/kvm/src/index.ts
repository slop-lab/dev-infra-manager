import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { workspaceImageReference } from "@slop-lab/dim-host-core";
import { ContainerWorkspaceRuntime, UserError, type CommandRunner } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";

const kvmDeviceNumber = 10 * 256 + 232;
const probe = `import os,fcntl,sys
fd=os.open(sys.argv[1],os.O_RDWR|os.O_CLOEXEC)
try:
 assert fcntl.ioctl(fd,0xae00,0)==12, 'unsupported KVM API'
 vm=fcntl.ioctl(fd,0xae01,0)
 os.close(vm)
finally: os.close(fd)
print('kvm-create-vm-ok')`;

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new UserError(`KVM state must be a private operator-owned directory: ${directory}`);
  }
}

export async function kvmDevice(stateRoot: string): Promise<string> {
  const directory = path.join(stateRoot, "plugins", "kvm"), device = path.join(directory, "kvm");
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new UserError("KVM configuration directory is not private and operator-owned");
  const info = await lstat(device);
  if (!info.isCharacterDevice() || info.isSymbolicLink() || info.rdev !== kvmDeviceNumber || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o7777) !== 0o666) throw new UserError("configured KVM node has unexpected identity or permissions; run dim kvm configure");
  try { const handle = await open(device, "r+"); await handle.close(); }
  catch { throw new UserError("private KVM node is inaccessible; the host state filesystem must permit devices (not nodev)"); }
  return device;
}

/** Prepare one fixed device using existing trusted operator Docker access. */
export async function configureKvm(stateRoot: string, runner: CommandRunner, image = workspaceImageReference(process.env.DIM_WORKSPACE_IMAGE), options: { signal?: AbortSignal; cleanupRunner?: CommandRunner } = {}): Promise<string> {
  const original = await lstat("/dev/kvm");
  if (!original.isCharacterDevice() || original.rdev !== kvmDeviceNumber) throw new UserError("host /dev/kvm is not the supported KVM character device (10:232)");
  const directory = path.join(stateRoot, "plugins", "kvm");
  if (!path.isAbsolute(directory) || /[\0\r\n,]/.test(directory)) throw new UserError("KVM state requires an absolute host directory without Docker mount delimiters");
  await privateDirectory(directory);
  try { return await kvmDevice(stateRoot); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const inspected = await runner.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const imageId = inspected.stdout.trim();
  if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new UserError("a reviewed local workspace image is required to configure KVM; run dim image build");
  const created = await runner.run("docker", ["create", "--runtime", "runc", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--cap-add", "MKNOD", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges", "--user", "0:0",
    "--mount", `type=bind,source=${directory},target=/output`, "--entrypoint", "/bin/sh", imageId,
    "-c", "test ! -e /output/kvm && test ! -L /output/kvm && mknod /output/kvm c 10 232 && chmod 0666 /output/kvm"], { ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const container = created.stdout.trim();
  if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(container)) throw new UserError(`KVM helper creation failed: ${created.stderr.trim()}`);
  try {
    const result = await runner.run("docker", ["start", "--attach", container], { ...(options.signal === undefined ? {} : { signal: options.signal }) });
    if (result.exitCode !== 0) throw new UserError(`KVM node preparation failed: ${result.stderr.trim()}`);
  } finally {
    const removed = await (options.cleanupRunner ?? runner).run("docker", ["rm", "--force", container]);
    if (removed.exitCode !== 0) throw new UserError(`cannot remove owned KVM preparation container ${container}: ${removed.stderr.trim()}`);
  }
  return kvmDevice(stateRoot);
}

export const hostPlugin: WorkspaceHostPlugin = {
  name: "kvm",
  runtime: {
    name: "container-kvm",
    defaultImage: workspaceImageReference(process.env.DIM_WORKSPACE_IMAGE),
    async create(context) {
      const device = await kvmDevice(context.stateRoot).catch((error: unknown) => { throw new UserError(`KVM runtime is not configured; run dim kvm configure: ${error instanceof Error ? error.message : String(error)}`); });
      return new ContainerWorkspaceRuntime(context.runner, context.cleanupRunner, { devices: [{ hostPath: device, containerPath: "/dev/kvm", major: 10, minor: 232, permissions: "rw" }] });
    }
  },
  commands: [{ name: "kvm", description: "Prepare explicit KVM workspace access and probe real KVM acceleration" }],
  async run(args, context) {
    if (args.length !== 2 || args[0] !== "kvm" || !["configure", "doctor"].includes(args[1] ?? "")) throw new UserError("usage: dim kvm configure | doctor");
    if (args[1] === "configure") {
      await configureKvm(context.stateRoot, context.runner, workspaceImageReference(process.env.DIM_WORKSPACE_IMAGE), { signal: context.signal, cleanupRunner: context.cleanupRunner });
      console.log("KVM workspace access prepared. Create with: dim create SOURCE NAME --runtime container-kvm");
    } else {
      const device = await kvmDevice(context.stateRoot);
      const result = await context.runner.run("python3", ["-c", probe, device]);
      if (result.exitCode !== 0) throw new UserError(`KVM VM creation probe failed (python3 is required): ${result.stderr.trim()}`);
      console.log(result.stdout.trim());
    }
  },
  guest: {
    description: "Explicit KVM device access for disposable VM verification; repository tooling owns QEMU and test VM setup",
    async inspect(workspace) {
      return workspace.runtime === "container-kvm" ? { state: "ready", message: "/dev/kvm is explicitly granted; run repository KVM verification prerequisites before launching VMs" } : { state: "unconfigured", message: "Create an explicitly selected container-kvm workspace to use KVM" };
    }
  }
};
