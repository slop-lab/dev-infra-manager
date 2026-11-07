import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it.each(["correct", "busy-root", "foreign-keeper", "missing-subgroup"] as const)("enables controllers only after exact supervisor ordering checks: %s", async (kind) => {
  const source = await readFile(new URL("./prepareHost.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf('await run("sudo", ["systemd-run"'), source.indexOf('const budget = join(output'));
  expect(code.length).toBeGreaterThan(0);
  const calls: string[][] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (args.includes("--property=ControlGroup")) return "/system.slice/dim-practical-budget.service";
    if (args.includes("--property=DelegateSubgroup")) return kind === "missing-subgroup" ? "" : "supervisor";
    if (args.includes("--property=MainPID")) return "2041";
    return "";
  };
  const files: string[] = [];
  const read = async (file: string) => {
    files.push(file);
    if (file.endsWith("/supervisor/cgroup.procs")) return kind === "foreign-keeper" ? "2041\n2042\n" : "2041\n";
    return kind === "busy-root" ? "2041\n" : "";
  };
  const result: Promise<unknown> = runInNewContext(`(async()=>{${code};return cgroupRoot})()`, { run, readFile: read });
  if (kind === "correct") {
    await expect(result).resolves.toBe("/sys/fs/cgroup/system.slice/dim-practical-budget.service");
    expect(calls[0]).toEqual(["sudo", "systemd-run", "--unit=dim-practical-budget", "--property=Delegate=yes", "--property=DelegateSubgroup=supervisor", "--property=CPUAccounting=yes", "--property=MemoryAccounting=yes", "--property=TasksAccounting=yes", "--property=RuntimeMaxSec=10800", "/usr/bin/sleep", "10800"]);
    expect(files).toEqual(["/sys/fs/cgroup/system.slice/dim-practical-budget.service/cgroup.procs", "/sys/fs/cgroup/system.slice/dim-practical-budget.service/supervisor/cgroup.procs"]);
    expect(calls.at(-1)).toEqual(["sudo", "sh", "-c", 'printf "+cpu +memory +pids\\n" > "$1/cgroup.subtree_control"', "ci-budget", "/sys/fs/cgroup/system.slice/dim-practical-budget.service"]);
  } else {
    await expect(result).rejects.toThrow();
    expect(calls.some((args) => args.includes("sh"))).toBe(false);
  }
});
