import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import path from "node:path";
import { budgetValues } from "./budget.js";
import type { WorkspaceResources } from "@slop-lab/dim-core/workspace";

export interface RootVmConfig { schemaVersion: 1; project: string; incusSocket: string; cgroupRoot: string; qemuExecutable: string }
export interface DesiredVmBudget { image: string; resources: WorkspaceResources }
const directory = "/var/lib/dim-vm-budget/limits";
export async function rootVmConfig(): Promise<RootVmConfig> {
  const file = "/etc/dim/vm-budget.json";
  await trustedPath(file);
  const config = record(JSON.parse(await readFile(file, "utf8")));
  if (Object.keys(config).sort().join() !== "cgroupRoot,incusSocket,project,qemuExecutable,schemaVersion" || config.schemaVersion !== 1
    || typeof config.project !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(config.project)
    || typeof config.incusSocket !== "string" || !path.isAbsolute(config.incusSocket)
    || typeof config.cgroupRoot !== "string" || !config.cgroupRoot.startsWith("/sys/fs/cgroup/") || path.normalize(config.cgroupRoot) !== config.cgroupRoot
    || typeof config.qemuExecutable !== "string" || !/^qemu-system-[a-zA-Z0-9_-]+$/.test(path.basename(config.qemuExecutable))) throw new Error("invalid root-owned VM budget configuration");
  await trustedPath(config.qemuExecutable, true);
  return { schemaVersion: 1, project: config.project, incusSocket: config.incusSocket, cgroupRoot: config.cgroupRoot, qemuExecutable: config.qemuExecutable };
}
export async function ownedVm(config: RootVmConfig, instance: string, missingAllowed: boolean, foreignAllowed = false): Promise<{ image: string } | undefined> {
  const value = await query(config, `/1.0/instances/${instance}?project=${encodeURIComponent(config.project)}`, missingAllowed);
  if (value === undefined) return undefined;
  const labels = record(value.config);
  if (foreignAllowed && labels["user.dim.owner"] !== "dim-vm-v1") return undefined;
  if (value.name !== instance || value.type !== "virtual-machine" || labels["user.dim.owner"] !== "dim-vm-v1"
    || labels["user.dim.workspace-id"] !== instance.slice(4) || typeof labels["user.dim.image"] !== "string"
    || !/^[a-f0-9]{64}$/.test(labels["user.dim.image"]) || labels["volatile.base_image"] !== labels["user.dim.image"]) throw new Error("Incus instance is not owned by DIM VM integration");
  return { image: labels["user.dim.image"] };
}
export async function writeDesiredBudget(instance: string, value: DesiredVmBudget): Promise<void> {
  budgetValues(value.resources); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/${instance}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, `${directory}/${instance}.json`);
  } finally { await rm(temporary, { force: true }); }
}
export async function desiredBudget(instance: string): Promise<DesiredVmBudget> {
  const file = `${directory}/${instance}.json`; await trustedPath(file);
  const value = record(JSON.parse(await readFile(file, "utf8")));
  if (Object.keys(value).sort().join() !== "image,resources" || typeof value.image !== "string" || !/^[a-f0-9]{64}$/.test(value.image)) throw new Error("invalid root VM budget intent");
  const resources = parseBudgetResources(value.resources); return { image: value.image, resources };
}
export async function removeDesiredBudget(instance: string): Promise<void> { await rm(`${directory}/${instance}.json`, { force: true }); }
export function parseBudgetResources(value: unknown): WorkspaceResources {
  const resources = record(value);
  if (Object.keys(resources).sort().join() !== "cpuCount,memory,pidsLimit" || typeof resources.cpuCount !== "string"
    || typeof resources.memory !== "string" || typeof resources.pidsLimit !== "string") throw new Error("invalid VM host resource request");
  const result = { cpuCount: resources.cpuCount, memory: resources.memory, pidsLimit: resources.pidsLimit }; budgetValues(result); return result;
}
export async function prepareDelegation(config: RootVmConfig): Promise<void> {
  await mkdir(config.cgroupRoot, { recursive: true });
  if (await realpath(config.cgroupRoot) !== config.cgroupRoot) throw new Error("VM cgroup delegation must be canonical");
  await writeFile(path.join(config.cgroupRoot, "cgroup.subtree_control"), "+cpu +memory +pids");
}
export async function trustedPath(file: string, executable = false): Promise<void> {
  if (await realpath(file) !== file) throw new Error("root VM budget path must be canonical");
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || (executable && !(metadata.mode & 0o111))) throw new Error("VM budget file must be root-owned and not group/world-writable");
  let parent = path.dirname(file);
  for (;;) {
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) throw new Error("untrusted VM budget file ancestor");
    if (parent === "/") break; parent = path.dirname(parent);
  }
}
export async function query(config: RootVmConfig, endpoint: string, missingAllowed: boolean): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath: config.incusSocket, path: endpoint, timeout: 10_000 }, (incoming) => {
      void body(incoming).then((data) => {
        if (incoming.statusCode === 404 && missingAllowed) { resolve(undefined); return; }
        if (incoming.statusCode !== 200) throw new Error("Incus rejected the independent VM identity query");
        resolve(record(record(JSON.parse(data)).metadata));
      }).catch(reject);
    });
    outgoing.once("error", reject); outgoing.once("timeout", () => outgoing.destroy(new Error("Incus VM identity query timed out"))); outgoing.end();
  });
}
export async function body(stream: NodeJS.ReadableStream): Promise<string> {
  let result = "";
  for await (const input of stream) {
    const chunk: unknown = input;
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) throw new Error("invalid helper request bytes");
    result += chunk.toString(); if (Buffer.byteLength(result) > 65536) throw new Error("VM helper request too large");
  }
  return result;
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid VM helper object");
  return value as Record<string, unknown>;
}
