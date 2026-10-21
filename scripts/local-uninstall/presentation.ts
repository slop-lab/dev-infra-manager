import { removalDirectories } from "./paths.ts";
import type { RemovalPlan } from "./plan.ts";
export function showRemovalPlan(plan: RemovalPlan): void {
  console.log("Local DIM removal plan (includes workspace and service data):");
  for (const resource of plan.docker.filter(({ claim }) => !plan.retainedCache.volumes.includes(claim.name))) console.log(`  Docker ${resource.claim.kind}: ${resource.claim.name}`);
  for (const volume of plan.retainedCache.volumes) console.log(`  Keep cache volume: ${volume}`);
  for (const file of plan.retainedCache.files) console.log(`  Keep ownership ledger: ${file}`);
  for (const vm of plan.vms) console.log(`  Incus VM: ${vm.project}/${vm.name}`);
  for (const process of plan.processes) console.log(`  Process: ${process.pid} (${process.command})`);
  if (plan.unit) console.log(`  Controller unit: ${plan.paths.unit}`);
  if (plan.bin) console.log(`  Managed executable: ${plan.paths.bin}`);
  for (const version of plan.mise) console.log(`  mise: ${version}`);
  for (const root of removalDirectories(plan.paths)) console.log(`  Directory: ${root}`);
  console.log(`  Configuration: ${plan.paths.config}`);
}
