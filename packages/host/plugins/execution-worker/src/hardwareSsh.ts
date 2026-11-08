import { constants } from "node:fs";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { parseAssignment, isTaskAssignment } from "./client.js";
import { containerName, ownershipLabels } from "./backends/containers.js";
import type { ExecutionGrant } from "@slop-lab/dim-contracts-ci/execution";

export const hardwareSshPort = 2222;
/** Keys never enter the public job/workspace shares. Only the guest server key and operator public key enter cloud-init. */
export async function prepareHardwareSsh(directory: string, runner: StreamingCommandRunner, signal: AbortSignal): Promise<void> {
  for (const name of ["operator-key", "guest-host-key"]) {
    const result = await runner.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "dim-disposable-verification", "-f", join(directory, name)], { signal });
    if (result.exitCode !== 0) throw new Error("verification SSH key generation failed");
  }
}
function quote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("unsafe verification SSH path");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
export async function publishHardwareSsh(directory: string, grant: ExecutionGrant, runner: StreamingCommandRunner, signal: AbortSignal): Promise<void> {
  const connection = await inspectHardwareSsh(grant, runner, signal), port = connection.port;
  const hostKey = (await readFile(join(directory, "guest-host-key.pub"), "utf8")).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(hostKey)) throw new Error("invalid verification SSH host key");
  const alias = `dim-verification-${grant.executionId}`;
  await writeFile(join(directory, "known_hosts"), `${alias} ${hostKey}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "ssh-connection.json"), JSON.stringify({ executionId: grant.executionId, descriptorDigest: grant.descriptorDigest, ...connection }), { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "ssh_config"), `Host dim-verification\n  HostName 127.0.0.1\n  Port ${port}\n  User dim\n  IdentityFile ${quote(join(directory, "operator-key"))}\n  UserKnownHostsFile ${quote(join(directory, "known_hosts"))}\n  GlobalKnownHostsFile /dev/null\n  HostKeyAlgorithms ssh-ed25519\n  UpdateHostKeys no\n  HostKeyAlias ${alias}\n  StrictHostKeyChecking yes\n  IdentitiesOnly yes\n  ForwardAgent no\n  ConnectTimeout 10\n`, { mode: 0o600, flag: "wx" });
}
async function inspectHardwareSsh(grant: ExecutionGrant, runner: StreamingCommandRunner, signal: AbortSignal): Promise<{ containerId: string; port: number }> {
  const result = await runner.run("docker", ["container", "inspect", containerName(grant)], { signal });
  if (result.exitCode !== 0) throw new Error("verification VM is unavailable");
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); } catch { throw new Error("invalid verification container inspection"); }
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid verification container inspection");
  const row = rows[0];
  if (!row || !/^[a-f0-9]{64}$/.test(row.Id) || row.State?.Running !== true
    || ownershipLabels(grant, "qemu").some(label => { const at = label.indexOf("="); return row.Config?.Labels?.[label.slice(0, at)] !== label.slice(at + 1); })) throw new Error("verification container ownership changed");
  const ports = row.NetworkSettings?.Ports?.[`${hardwareSshPort}/tcp`];
  if (!Array.isArray(ports) || ports.length !== 1 || ports[0]?.HostIp !== "127.0.0.1" || !/^[1-9][0-9]{0,4}$/.test(ports[0]?.HostPort) || Number(ports[0].HostPort) > 65535) throw new Error("verification SSH requires an exact host-loopback port");
  return { containerId: row.Id, port: Number(ports[0].HostPort) };
}
async function privateBytes(path: string): Promise<Buffer> {
  if (await realpath(path) !== path) throw new Error("verification SSH requires canonical private files");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) throw new Error("unsafe verification SSH private file");
    return await file.readFile();
  } finally { await file.close(); }
}
async function privateJson(path: string) {
  const bytes = await privateBytes(path);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("invalid private verification SSH state"); }
}
/** Read-only selected-host discovery. Never returns credentials, grant contents or arbitrary candidate paths. */
export async function hardwareSshInfo(configFile: string, executionId: string, runner: StreamingCommandRunner, signal: AbortSignal) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(executionId)) throw new Error("complete execution UUID required");
  let config;
  try { config = executionWorkerConfigSchema.parse(await privateJson(configFile)); }
  catch { throw new Error("invalid private execution worker configuration"); }
  for (const slot of config.slots) {
    if (!("runtime" in slot) || slot.runtime !== "vm") continue;
    const parent = join(config.stateDirectory, slot.id);
    let bytes: Buffer;
    try { bytes = await privateBytes(join(parent, "execution.json")); } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue; throw error;
    }
    let journal;
    try { journal = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("invalid private verification SSH journal"); }
    if (journal.assignment?.id !== executionId) continue;
    const assignment = parseAssignment(journal.assignment);
    if (journal.pendingResult || journal.result || !["assigned", "running"].includes(assignment.phase) || assignment.generationId !== config.generationId || isTaskAssignment(assignment) || !assignment.grant || assignment.workerId !== config.workerId || assignment.slotId !== slot.id || assignment.grant.executionId !== executionId || assignment.grant.workerId !== config.workerId || assignment.grant.slotId !== slot.id || assignment.grant.generationId !== config.generationId) throw new Error("verification assignment ownership changed");
    const root = journal.root;
    if (root?.state !== "created" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(root.rootId)) throw new Error("verification private root unavailable");
    const path = join(parent, `work-${root.rootId}`), info = await lstat(path, { bigint: true });
    if (await realpath(path) !== path || !info.isDirectory() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n || info.dev.toString() !== root.device || info.ino.toString() !== root.inode) throw new Error("verification private root changed");
    const marker = await privateJson(join(path, ".dim-native-ordinary-owner.json"));
    if (marker.rootId !== root.rootId || marker.claimId !== executionId) throw new Error("verification private root marker mismatch");
    const current = await inspectHardwareSsh(assignment.grant, runner, signal), sshConfig = join(path, "hardware", "ssh_config");
    const connection = await privateJson(join(path, "hardware", "ssh-connection.json"));
    if (connection.executionId !== executionId || connection.descriptorDigest !== assignment.grant.descriptorDigest || connection.containerId !== current.containerId || connection.port !== current.port) throw new Error("verification SSH container identity changed");
    const port = current.port;
    const text = (await privateBytes(sshConfig)).toString("utf8");
    if (!text.includes(`\n  Port ${port}\n`)) throw new Error("verification SSH port changed");
    return { executionId, workerId: config.workerId, slotId: slot.id, hostLoopback: "127.0.0.1", port, sshConfig, command: ["ssh", "-F", sshConfig, "dim-verification"], runsOn: "selected execution host; use its normal operator SSH transport", ephemeral: true };
  }
  throw new Error("no active verification VM for this worker and execution");
}
