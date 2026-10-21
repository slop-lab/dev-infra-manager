import { mkdir, readlink, rm, writeFile, rename } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { collectControlPlaneClaims } from "./control-plane.ts";
import { collectHostClaims, collectVmClaims, type VmClaim } from "./host-resources.ts";
import { collectWorkerClaims } from "./worker-resources.ts";
import { planDocker, removeDocker, inspectDocker, type DockerResource } from "./docker.ts";
import { metadata, object, readJson, text } from "./files.ts";
import { command, checked, type Command } from "./command.ts";
import { ownedControllerUnit, stopControllerUnit } from "./controller-unit.ts";
import { planProcesses, stopProcesses, type OwnedProcess } from "./processes.ts";
import { inside, removalDirectories, validatePaths } from "./paths.ts";
import { planMise, removeMise } from "./mise.ts";
import { inspectVm, removeVms } from "./vm.ts";
import { retainedCacheData, removeExcept, type RetainedCacheData } from "./cache-data.ts";
import { retainedPersistentData, type PersistentData } from "./persistent-data.ts";
import type { RemovalPaths } from "./types.ts";
export interface RemovalPlan {
  readonly schemaVersion: 1;
  readonly keepCacheData: boolean;
  readonly retainedCache: RetainedCacheData;
  readonly persistent: PersistentData;
  readonly paths: RemovalPaths;
  readonly docker: readonly DockerResource[];
  readonly vms: readonly VmClaim[];
  readonly mise: readonly string[];
  readonly processes: readonly OwnedProcess[];
  readonly unit: boolean;
  readonly bin: boolean;
}
const journal = (paths: RemovalPaths) => join(paths.data, "local-uninstall.json");
async function managedBin(paths: RemovalPaths): Promise<boolean> {
  const stat = await metadata(paths.bin); if (!stat) return false;
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error(`foreign dim executable: ${paths.bin}`);
  const target = resolve(dirname(paths.bin), await readlink(paths.bin));
  if (!removalDirectories(paths).some((root) => inside(target, root))) throw new Error(`dim executable points outside this installation: ${paths.bin}`);
  return true;
}
function restoredPlan(raw: unknown, paths: RemovalPaths): RemovalPlan {
  const value = object(raw);
  if (value.schemaVersion !== 1 || JSON.stringify(value.paths) !== JSON.stringify(paths)
    || !Array.isArray(value.docker) || !Array.isArray(value.vms) || !Array.isArray(value.mise)) throw new Error("incompatible local uninstall journal");
  const retained = object(value.retainedCache);
  if (typeof value.keepCacheData !== "boolean" || !Array.isArray(retained.files) || !Array.isArray(retained.volumes)) throw new Error("invalid retained cache journal");
  for (const file of retained.files) {
    const path = text(file);
    if (![paths.state, paths.managed].some((root) => inside(path, join(root, "plugins/cache-server/services")))) throw new Error("invalid retained cache path");
  }
  for (const volume of retained.volumes) text(volume);
  if (!value.keepCacheData && (retained.files.length || retained.volumes.length)) throw new Error("unexpected retained cache data");
  const persistent = object(value.persistent);
  if (!Array.isArray(persistent.files) || !Array.isArray(persistent.volumes)) throw new Error("invalid persistent service journal");
  for (const file of persistent.files) if (!removalDirectories(paths).some((root) => inside(text(file), root))) throw new Error("invalid persistent service path");
  for (const volume of persistent.volumes) text(volume);
  for (const raw of value.docker) {
    const item = object(raw), claim = object(item.claim);
    if (!["container", "volume", "network"].includes(text(claim.kind)) || !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(text(claim.name))) throw new Error("invalid journal resource");
    text(item.id); text(item.created);
    if (Object.keys(object(claim.labels)).length === 0) throw new Error("journal resource lacks ownership labels");
    for (const [key, value] of Object.entries(object(claim.labels))) { text(key); text(value); }
  }
  for (const raw of value.vms) { const vm = object(raw); for (const field of ["project", "name", "id", "image"]) text(vm[field]); }
  for (const version of value.mise) if (!/^npm:@slop-lab\/dim-installer@[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(text(version))) throw new Error("invalid journal mise registration");
  return value as unknown as RemovalPlan;
}
export async function createRemovalPlan(paths: RemovalPaths, run: Command = command, env: NodeJS.ProcessEnv = process.env, options: { keepCacheData?: boolean } = {}): Promise<RemovalPlan> {
  await validatePaths(paths);
  const file = journal(paths), prior = await readJson(file);
  if (prior !== undefined && ((await metadata(file))!.mode & 0o777) !== 0o600) throw new Error("unsafe local uninstall journal permissions");
  const active = await planProcesses(paths), unit = await ownedControllerUnit(paths), bin = await managedBin(paths);
  if (prior !== undefined) {
    const previous = restoredPlan(prior, paths);
    if (previous.keepCacheData !== (options.keepCacheData === true)) throw new Error("retry uninstall with the same --keep-cache-data selection");
    // The durable snapshot authorizes retry after its Caddy container was removed;
    // IDs, labels and creation times are rechecked before any further deletion.
    for (const resource of previous.docker) await inspectDocker(run, resource.claim);
    for (const vm of previous.vms) await inspectVm(run, vm);
    return { ...previous, processes: active.processes, unit, bin, mise: await planMise(run, env) };
  }
  const serviceConfigs = active.processes.flatMap((process) => process.configFile === undefined ? [] : [process.configFile]);
  const preliminaryPersistence = await retainedPersistentData(paths, serviceConfigs);
  const claims = [...await collectHostClaims(paths), ...await collectControlPlaneClaims(paths.controlPlane),
    ...await collectWorkerClaims([...new Set([paths.state, paths.managed, ...active.workerRoots])], preliminaryPersistence.files)];
  const vms = await collectVmClaims(paths);
  for (const vm of vms) await inspectVm(run, vm);
  const docker = await planDocker(run, claims), keepCacheData = options.keepCacheData === true;
  const persistent = await retainedPersistentData(paths, serviceConfigs, docker);
  const retainedCache = keepCacheData ? await retainedCacheData(paths, docker) : { volumes: [], files: [] };
  return { schemaVersion: 1, paths, keepCacheData, retainedCache, persistent, docker, vms, mise: await planMise(run, env), processes: active.processes, unit, bin };
}
export async function executeRemoval(plan: RemovalPlan, run: Command = command): Promise<void> {
  const paths = plan.paths;
  await validatePaths(paths);
  if (plan.unit !== await ownedControllerUnit(paths) || plan.bin !== await managedBin(paths)) throw new Error("installation changed after planning");
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const file = journal(paths), stage = `${file}.tmp-${process.pid}`;
  await writeFile(stage, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
  await rename(stage, file);
  await stopControllerUnit(run, plan.unit);
  await stopProcesses(plan.processes);
  // Check that no newly launched producer/worker can recreate resources during removal.
  if ((await planProcesses(paths)).processes.length) throw new Error("a DIM process started during uninstall; stop it and retry");
  await removeDocker(run, plan.docker, [...plan.retainedCache.volumes, ...plan.persistent.volumes]);
  await removeVms(run, plan.vms);
  // Retain runtime and its ownership records until all external cleanup succeeds.
  await removeMise(run, plan.mise);
  if (plan.unit) { await rm(paths.unit); await checked(run, "systemctl", ["--user", "daemon-reload"]); }
  if (plan.bin) await rm(paths.bin);
  const retainedFiles = [...plan.retainedCache.files, ...plan.persistent.files];
  await removeExcept(paths.config, retainedFiles);
  for (const root of removalDirectories(paths).filter((root) => root !== paths.data)) await removeExcept(root, retainedFiles);
  await removeExcept(paths.data, retainedFiles);
}
