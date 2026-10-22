import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectControlPlaneDocker } from "../../packages/installer/src/controlPlaneDockerInspect.ts";
import type { ControlPlaneDockerRunner } from "../../packages/installer/src/controlPlaneDockerTypes.ts";

type Service = "native-git" | "execution";
export type VolumeCheckpoint = { readonly service: Service; readonly sha256: string };
const services = ["native-git", "execution"] as const;
const volume = (service: Service) => `dim-control-plane-${service}-data`;
const statePath = (service: Service) => service === "native-git" ? "/var/lib/dim-native-git" : "/var/lib/dim-execution";

export async function runDocker(runner: ControlPlaneDockerRunner, args: readonly string[], timeoutMilliseconds = 60_000): Promise<string> {
  const result = await runner.run({ args, timeoutMilliseconds, maximumOutputBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error("local control-plane Docker operation failed");
  return result.stdout;
}
export async function stopOwnedServices(runner: ControlPlaneDockerRunner, deploymentId: string): Promise<void> {
  const owned = await inspectControlPlaneDocker(runner, deploymentId, true);
  if (owned.kind !== "owned") throw new Error("cannot checkpoint or restore incomplete owned resources");
  const ids = [owned.executionContainerId, owned.nativeGitContainerId];
  await runDocker(runner, ["container", "stop", "--time", "20", ...ids]);
  for (const id of ids) {
    if (await runDocker(runner, ["container", "inspect", id, "--format", "{{.State.Running}}\n{{.State.Restarting}}"], 10_000) !== "false\nfalse\n") {
      throw new Error("both service processes must be confirmed stopped before copying or restoring data");
    }
  }
}
function archiveArgs(image: string, directory: string, service: Service, restore: boolean): string[] {
  if (directory.includes(",")) throw new Error("backup path cannot contain a comma");
  const dataMount = `type=volume,src=${volume(service)},dst=/data${restore ? "" : ",readonly"}`;
  const backupMount = `type=bind,src=${resolve(directory)},dst=/backup${restore ? ",readonly" : ""}`;
  return ["run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL",
    "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges:true",
    "--mount", dataMount, "--mount", backupMount, "--entrypoint", "/bin/sh", image, "-ec"];
}
async function runArchive(runner: ControlPlaneDockerRunner, args: readonly string[], timeoutMilliseconds: number): Promise<void> {
  const name = `dim-local-checkpoint-${randomBytes(16).toString("hex")}`;
  try { await runDocker(runner, [args[0]!, "--name", name, ...args.slice(1)], timeoutMilliseconds); }
  finally {
    const cleanup = await runner.run({ args: ["container", "rm", "--force", name], timeoutMilliseconds: 10_000, maximumOutputBytes: 4096 });
    if (cleanup.exitCode !== 0 && !cleanup.stderr.includes("No such container")) throw new Error("checkpoint helper termination is uncertain; recovery was stopped");
  }
}
export async function checkpointVolumes(runner: ControlPlaneDockerRunner, image: string, directory: string): Promise<readonly VolumeCheckpoint[]> {
  const uid = process.geteuid?.(), gid = process.getegid?.();
  if (uid === undefined || gid === undefined) throw new Error("local control-plane checkpoints require POSIX ownership");
  const results: VolumeCheckpoint[] = [];
  for (const service of services) {
    await runArchive(runner, [...archiveArgs(image, directory, service, false),
      'umask 077; tar --numeric-owner -cpf "/backup/$1.tar" -C /data .; chown "$2:$3" "/backup/$1.tar"',
      "checkpoint", service, String(uid), String(gid)], 60_000);
    results.push({ service, sha256: await archiveDigest(directory, service) });
  }
  return results;
}
async function archiveDigest(directory: string, service: Service): Promise<string> {
  const handle = await open(join(directory, `${service}.tar`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.geteuid?.() ?? -1) || (before.mode & 0o777n) !== 0o600n || before.nlink !== 1n) {
      throw new Error("local control-plane checkpoint is not a private owned regular file");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("checkpoint changed while hashing");
    return hash.digest("hex");
  } finally { await handle.close(); }
}
export async function restoreVolumes(runner: ControlPlaneDockerRunner, image: string, directory: string, checkpoints: readonly VolumeCheckpoint[]): Promise<void> {
  if (checkpoints.length !== services.length || services.some((service) => checkpoints.filter((entry) => entry.service === service).length !== 1)) {
    throw new Error("local restore requires both exact service checkpoints");
  }
  // Verify the complete pair before mutating either volume.
  for (const checkpoint of checkpoints) {
    if (await archiveDigest(directory, checkpoint.service) !== checkpoint.sha256) throw new Error("local control-plane checkpoint digest changed");
  }
  for (const service of services) {
    await runArchive(runner, [...archiveArgs(image, directory, service, true),
      'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar --numeric-owner --same-owner -xpf "/backup/$1.tar" -C /data',
      "restore", service], 60_000);
  }
}
export async function forwardReadable(runner: ControlPlaneDockerRunner, image: string, service: Service): Promise<void> {
  const prefix = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--user", service === "native-git" ? "10001:10001" : "10002:10002", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777"];
  const executable = ["--entrypoint", "/usr/local/bin/dim-service", image];
  const compatibility: unknown = JSON.parse(await runDocker(runner, [...prefix, ...executable, "compatibility", "--json"], 30_000));
  const state: unknown = JSON.parse(await runDocker(runner, [...prefix, "--mount", `type=volume,src=${volume(service)},dst=${statePath(service)},readonly`,
    ...executable, "check-state", "--read-only", statePath(service), "--json"], 30_000));
  if (!isRecord(compatibility) || compatibility.schemaVersion !== 1 || !Number.isSafeInteger(compatibility.writeFormat) || !Array.isArray(compatibility.readableFormats)
    || !isRecord(state) || state.schemaVersion !== 1 || !Number.isSafeInteger(state.stateFormat)
    || !compatibility.readableFormats.includes(state.stateFormat) || !compatibility.readableFormats.includes(compatibility.writeFormat)) {
    throw new Error("candidate cannot read the stopped deployment state");
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Raw service logs may contain secrets: retain bounded diagnostics only inside the private checkpoint. */
export async function captureServiceLogs(runner: ControlPlaneDockerRunner, directory: string, containers: {
  readonly nativeGitContainerId: string; readonly executionContainerId: string;
}): Promise<void> {
  await Promise.allSettled(([['native-git', containers.nativeGitContainerId], ['execution', containers.executionContainerId]] as const)
    .map(async ([service, containerId]) => {
      const result = await runner.run({ args: ["container", "logs", "--timestamps", "--tail", "200", containerId],
        timeoutMilliseconds: 10_000, maximumOutputBytes: 256 * 1024 });
      // Keep daemon errors private as well; diagnostic failure must never prevent restoration.
      await writeFile(join(directory, `diagnostics-${service}.log`), `${result.stdout}${result.stderr}`,
        { mode: 0o600, flag: "wx" });
    }));
}
