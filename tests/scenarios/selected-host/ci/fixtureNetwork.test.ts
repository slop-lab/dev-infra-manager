import { expect, it } from "vitest";
import { cleanupIncusForwarding, prepareIncusForwarding } from "./fixtureNetwork.ts";
import type { CommandResult } from "../../web-lifecycle/process.ts";

const identity = { sourceSha: "a".repeat(40), machine: "b".repeat(32) };
function fixture() {
  const commands: string[][] = [], rules = new Set<string>();
  let network = { name: "practical-ci", type: "bridge", managed: true, status: "Created", config: { "ipv4.address": "10.211.42.1/24", "ipv4.nat": "true", "ipv6.address": "none" } };
  let rejectReturn = false;
  const execute = async (file: string, args: readonly string[]): Promise<CommandResult> => {
    commands.push([file, ...args]);
    let stdout = "", exitCode = 0;
    if (file === "sudo" && args[0] === "incus") stdout = JSON.stringify(network);
    else if (file === "ip" && args.includes("link")) stdout = JSON.stringify([{ ifname: "practical-ci", linkinfo: { info_kind: "bridge" } }]);
    else if (file === "ip") stdout = JSON.stringify([{ ifname: "practical-ci", addr_info: [{ family: "inet", local: "10.211.42.1", prefixlen: 24 }] }]);
    else if (file === "sysctl") stdout = "1\n";
    else {
      const action = args[3], key = args.slice(action === "-I" ? 6 : 5).join(" ");
      if (action === "-C") exitCode = rules.has(key) ? 0 : 1;
      else if (action === "-I") { if (rejectReturn && args.includes("RELATED,ESTABLISHED")) exitCode = 2; else rules.add(key); }
      else if (action === "-D") rules.delete(key);
      else throw new Error("unexpected firewall operation");
    }
    return { stdout, stderr: "", exitCode };
  };
  return { execute, commands, rules, replaceNetwork: (value: typeof network) => { network = value; }, failReturn: () => { rejectReturn = true; } };
}

it("permits only the validated newly owned bridge/subnet and cleans up only exact commented rules", async () => {
  const f = fixture(), receipt = await prepareIncusForwarding(identity, f.execute);
  expect(receipt).toMatchObject({ ...identity, bridge: "practical-ci", subnet: "10.211.42.0/24", inserted: ["egress", "return"] });
  const inserted = f.commands.filter((args) => args.includes("-I")); expect(inserted).toHaveLength(2);
  expect(inserted[0]).toEqual(["sudo", "iptables", "-w", "5", "-I", "FORWARD", "1", "-i", "practical-ci", "!", "-o", "practical-ci", "-s", "10.211.42.0/24", "-m", "comment", "--comment", receipt.comment, "-j", "ACCEPT"]);
  expect(inserted[1]).toEqual(["sudo", "iptables", "-w", "5", "-I", "FORWARD", "1", "-o", "practical-ci", "-d", "10.211.42.0/24", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-m", "comment", "--comment", receipt.comment, "-j", "ACCEPT"]);
  f.rules.add("unrelated operator rule");
  await cleanupIncusForwarding(receipt, identity, f.execute);
  expect([...f.rules]).toEqual(["unrelated operator rule"]);
  expect(f.commands.some((args) => args.includes("-F") || args.includes("-P"))).toBe(false);
});
it.each(["name", "subnet", "nat", "managed"])("rejects foreign %s before any firewall change", async (field) => {
  const f = fixture();
  f.replaceNetwork({ name: field === "name" ? "operator-bridge" : "practical-ci", type: "bridge", managed: field !== "managed", status: "Created", config: { "ipv4.address": field === "subnet" ? "10.91.73.1/24" : "10.211.42.1/24", "ipv4.nat": field === "nat" ? "false" : "true", "ipv6.address": "none" } });
  await expect(prepareIncusForwarding(identity, f.execute)).rejects.toThrow();
  expect(f.commands.some((args) => args.includes("iptables"))).toBe(false);
});
it("rolls back only its own first rule after second insertion fails", async () => {
  const f = fixture(); f.rules.add("unrelated operator rule"); f.failReturn();
  await expect(prepareIncusForwarding(identity, f.execute)).rejects.toThrow();
  expect([...f.rules]).toEqual(["unrelated operator rule"]);
});
it("refuses cleanup receipts from another machine or source without executing commands", async () => {
  const f = fixture(), receipt = await prepareIncusForwarding(identity, f.execute), before = f.commands.length;
  for (const foreign of [{ ...receipt, machine: "c".repeat(32) }, { ...receipt, sourceSha: "d".repeat(40) }, { ...receipt, subnet: "0.0.0.0/0" }]) await expect(cleanupIncusForwarding(foreign, identity, f.execute)).rejects.toThrow();
  expect(f.commands).toHaveLength(before);
});
