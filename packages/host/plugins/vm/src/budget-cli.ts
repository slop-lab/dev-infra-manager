import { LinuxVmBudget } from "./budget.js";
import { withVmBudgetLock } from "./budget-lock.js";
import { body, ownedVm, parseBudgetResources, prepareDelegation, query, record, removeDesiredBudget, rootVmConfig, writeDesiredBudget } from "./budget-policy.js";

/** Standalone root program: imports only root-installed siblings and Node builtins. */
try { await main(); }
catch (error) { process.stderr.write(`dim-vm-budget: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("VM budget helper requires root");
  process.umask(0o077);
  const config = await rootVmConfig(), operation = process.argv[2];
  if (!["prepare", "apply", "verify", "release"].includes(operation ?? "") || process.argv.length !== 3) throw new Error("usage: dim-vm-budget prepare|apply|verify|release (JSON stdin)");
  const input = record(JSON.parse(await body(process.stdin)));
  const keys = operation === "release" ? "instance" : operation === "prepare" ? "instance,resources" : "instance,pid,resources";
  if (Object.keys(input).sort().join() !== keys || typeof input.instance !== "string"
    || !/^dim-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.instance)) throw new Error("invalid owned VM budget request");
  const instance = input.instance;
  await withVmBudgetLock(instance, async () => {
    const owned = await ownedVm(config, instance, operation === "release");
    const budget = new LinuxVmBudget(config.cgroupRoot);
    if (operation === "release") { await budget.release(instance); await removeDesiredBudget(instance); return; }
    if (owned === undefined) throw new Error("owned VM does not exist");
    const resources = parseBudgetResources(input.resources);
    const state = await query(config, `/1.0/instances/${instance}/state?project=${encodeURIComponent(config.project)}`, false);
    if (operation === "prepare") {
      await prepareDelegation(config);
      const pid = state?.status_code === 103 && typeof state.pid === "number" ? state.pid : undefined;
      await budget.configure({ instance, ...(pid === undefined ? {} : { pid }) }, resources);
      await writeDesiredBudget(instance, { image: owned.image, resources }); return;
    }
    if (typeof input.pid !== "number" || !Number.isSafeInteger(input.pid) || input.pid <= 0
      || state?.pid !== input.pid || state.status_code !== 103) throw new Error("requested QEMU PID is not this running Incus VM");
    await budget[operation === "apply" ? "apply" : "verify"]({ instance, pid: input.pid }, resources);
    if (operation === "apply") await writeDesiredBudget(instance, { image: owned.image, resources });
  });
  process.stdout.write('{"ok":true}\n');
}
