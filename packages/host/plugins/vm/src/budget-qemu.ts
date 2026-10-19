import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { LinuxVmBudget } from "./budget.js";
import { withVmBudgetLock } from "./budget-lock.js";
import { desiredBudget, ownedVm, rootVmConfig, trustedPath } from "./budget-policy.js";

/** Admit the immediate root shell parent; its subsequent exec preserves Incus' inherited device FDs. */
try {
  if (process.getuid?.() !== 0) throw new Error("Incus QEMU admission requires root");
  process.umask(0o077);
  const pid = Number(process.argv[2]), config = await rootVmConfig(), args = process.argv.slice(3);
  if (!Number.isSafeInteger(pid) || pid !== process.ppid || pid <= 1) throw new Error("QEMU admission target must be this helper's immediate parent");
  const parent = `/proc/${pid}`;
  if ((await lstat(parent)).uid !== 0 || await realpath(`${parent}/exe`) !== await realpath("/bin/sh")) throw new Error("QEMU launch parent must be the root shell wrapper");
  const born = await readFile(`${parent}/stat`, "utf8");
  const command = (await readFile(`${parent}/cmdline`, "utf8")).split("\0");
  const wrapper = `/usr/local/lib/dim-vm-budget/qemu/${path.basename(config.qemuExecutable)}`;
  await trustedPath(wrapper, true);
  if (!command[1] || await realpath(command[1]) !== wrapper || JSON.stringify(command.slice(2, -1)) !== JSON.stringify(args)) throw new Error("QEMU launch parent does not match the installed wrapper and arguments");
  const index = args.indexOf("-name"), instance = index < 0 ? undefined : args[index + 1]?.split(",")[0];
  if (instance && /^dim-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance)) {
    const owned = await ownedVm(config, instance, true, true);
    if (owned !== undefined) await withVmBudgetLock(instance, async () => {
      const current = await ownedVm(config, instance, false), desired = await desiredBudget(instance);
      if (current?.image !== desired.image) throw new Error("VM image changed since root budget admission");
      if (process.ppid !== pid || (await readFile(`${parent}/stat`, "utf8")).split(") ")[1]?.split(" ")[19] !== born.split(") ")[1]?.split(" ")[19]) throw new Error("QEMU shell parent identity changed before admission");
      await new LinuxVmBudget(config.cgroupRoot).admit(instance, desired.resources, pid);
    });
  }
} catch (error) {
  process.stderr.write(`dim-vm QEMU admission: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
