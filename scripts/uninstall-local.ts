#!/usr/bin/env node
import { parseArgs } from "node:util";
import { removalDirectories, removalPaths } from "./local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "./local-uninstall/plan.ts";
const parsed = parseArgs({ options: { yes: { type: "boolean" }, "keep-cache-data": { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: false });
if (parsed.values.help) {
  console.log("Usage: just uninstall-local [--yes] [--keep-cache-data]\n\nPreview removal of this user's selected local DIM installation. --yes deletes\nworkspace/service data, credentials, runtimes and mise DIM installer versions.\n--keep-cache-data retains cache payload volumes and ownership ledgers only.\nKeeps shared host dependencies, source checkout and prepared build artifacts.\nThis repository tool is not a published DIM command.");
} else {
  try {
    const plan = await createRemovalPlan(removalPaths(), undefined, undefined, { keepCacheData: parsed.values["keep-cache-data"] === true });
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
    if (parsed.values.yes) { await executeRemoval(plan); console.log(`Local DIM installation removed. Prepared source artifacts${plan.keepCacheData ? " and cache data" : ""} are retained.`); }
    else console.log("Preview only. Run just uninstall-local --yes to remove these resources.");
  } catch (error) { console.error(`uninstall-local: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
