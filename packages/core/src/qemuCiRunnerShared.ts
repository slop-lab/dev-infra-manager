import { UserError } from "./errors.js";
import type { CiRunnerRecord, QemuSchedulerProjectConnection } from "./lifecycleTypes.js";

export function assertQemuSchedulerTopology(
  records: readonly CiRunnerRecord[],
  projectName: string,
  scheduler: QemuSchedulerProjectConnection | undefined,
  excludedCapacity?: string
): void {
  const peers = records.filter((record) => record.projectName === projectName
    && record.name !== excludedCapacity
    && record.executor.kind === "qemu");
  const shared = peers.filter((record) => record.executor.kind === "qemu" && record.executor.scheduler !== undefined);
  if (scheduler === undefined && shared.length > 0) {
    throw new UserError(`Project '${projectName}' already uses shared QEMU scheduling`);
  }
  if (scheduler !== undefined && shared.length !== peers.length) {
    throw new UserError(`Project '${projectName}' has mixed local and shared QEMU scheduling; reconcile every capacity in one mode`);
  }
  if (scheduler !== undefined && shared.some((record) => record.executor.kind === "qemu"
    && (record.executor.scheduler?.projectId !== scheduler.projectId || record.executor.scheduler.hostId !== scheduler.hostId))) {
    throw new UserError(`Project '${projectName}' shared QEMU scheduler identity conflicts with local capacity state`);
  }
}

export function assertPersistedQemuScheduler(
  record: CiRunnerRecord,
  scheduler: QemuSchedulerProjectConnection | undefined
): void {
  if (record.executor.kind !== "qemu") return;
  const persisted = record.executor.scheduler;
  if (persisted === undefined && scheduler === undefined) return;
  if (persisted === undefined || scheduler === undefined
    || persisted.projectId !== scheduler.projectId || persisted.hostId !== scheduler.hostId) {
    throw new UserError(`QEMU CI runner '${record.projectName}/${record.name}' scheduler mode or identity changed; restart all Project capacities together`);
  }
}
