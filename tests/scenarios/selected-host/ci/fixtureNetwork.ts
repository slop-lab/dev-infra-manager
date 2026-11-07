import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CommandResult } from "../../web-lifecycle/process.ts";

export const incusPackages = ["incus", "qemu-system-x86", "qemu-utils", "ovmf", "build-essential", "genisoimage", "iptables", "iproute2"] as const;
type FixtureIdentity = { readonly sourceSha: string; readonly machine: string };
type Execute = (file: string, args: readonly string[]) => Promise<CommandResult>;
const networkSchema = z.object({ name: z.literal("practical-ci"), type: z.literal("bridge"), managed: z.literal(true), status: z.literal("Created"),
  config: z.object({ "ipv4.address": z.literal("10.211.42.1/24"), "ipv4.nat": z.literal("true"), "ipv6.address": z.literal("none") }) });
const receiptSchema = z.object({ schemaVersion: z.literal(1), machine: z.string().regex(/^[a-f0-9]{32}$/), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  bridge: z.literal("practical-ci"), subnet: z.literal("10.211.42.0/24"), comment: z.string().regex(/^dim-practical-ci-[a-f0-9-]{36}$/),
  inserted: z.array(z.enum(["egress", "return"])).max(2).refine((items) => new Set(items).size === items.length) }).strict();
type Receipt = z.infer<typeof receiptSchema>;
function rule(receipt: Receipt, direction: "egress" | "return"): readonly string[] {
  const match = direction === "egress" ? ["-i", receipt.bridge, "!", "-o", receipt.bridge, "-s", receipt.subnet]
    : ["-o", receipt.bridge, "-d", receipt.subnet, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED"];
  return [...match, "-m", "comment", "--comment", receipt.comment, "-j", "ACCEPT"];
}
async function checked(execute: Execute, file: string, args: readonly string[]): Promise<string> {
  const result = await execute(file, args);
  if (result.exitCode !== 0) throw new Error(`fixture prerequisite command failed: ${file} ${args.join(" ")} (exit ${result.exitCode})`);
  return result.stdout.trim();
}
export function requireIncusForwarding(value: unknown, identity: FixtureIdentity): Receipt {
  const receipt = receiptSchema.parse(value);
  if (receipt.machine !== identity.machine || receipt.sourceSha !== identity.sourceSha) throw new Error("foreign Incus forwarding receipt");
  return receipt;
}
export async function cleanupIncusForwarding(value: unknown, identity: FixtureIdentity, execute: Execute): Promise<void> {
  const receipt = requireIncusForwarding(value, identity);
  const failures: unknown[] = [];
  for (const direction of [...receipt.inserted].reverse()) {
    try {
      const args = rule(receipt, direction), existing = await execute("sudo", ["iptables", "-w", "5", "-C", "FORWARD", ...args]);
      if (existing.exitCode === 1) continue;
      if (existing.exitCode !== 0) throw new Error("cannot inspect exact owned forwarding rule");
      await checked(execute, "sudo", ["iptables", "-w", "5", "-D", "FORWARD", ...args]);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "owned Incus forwarding cleanup incomplete; disposable VM teardown remains required");
}
export async function prepareIncusForwarding(identity: FixtureIdentity, execute: Execute): Promise<Receipt> {
  const network = networkSchema.parse(JSON.parse(await checked(execute, "sudo", ["incus", "--force-local", "query", "/1.0/networks/practical-ci"])));
  const link = z.array(z.object({ ifname: z.literal(network.name), linkinfo: z.object({ info_kind: z.literal("bridge") }) })).length(1);
  link.parse(JSON.parse(await checked(execute, "ip", ["-j", "-d", "link", "show", "dev", network.name])));
  const addresses = z.array(z.object({ ifname: z.literal(network.name), addr_info: z.array(z.object({ family: z.string(), local: z.string(), prefixlen: z.number() })) })).length(1)
    .parse(JSON.parse(await checked(execute, "ip", ["-j", "-4", "address", "show", "dev", network.name])));
  if (!addresses[0]?.addr_info.some((address) => address.family === "inet" && `${address.local}/${address.prefixlen}` === network.config["ipv4.address"])
    || await checked(execute, "sysctl", ["-n", "net.ipv4.ip_forward"]) !== "1") throw new Error("owned bridge address or IPv4 forwarding prerequisite mismatch");
  const subnet = network.config["ipv4.address"].slice(0, network.config["ipv4.address"].lastIndexOf(".")) + ".0/24";
  const receipt = receiptSchema.parse({ schemaVersion: 1, ...identity, bridge: network.name, subnet, comment: `dim-practical-ci-${randomUUID()}`, inserted: [] });
  try {
    for (const direction of ["egress", "return"] as const) {
      const args = rule(receipt, direction), existing = await execute("sudo", ["iptables", "-w", "5", "-C", "FORWARD", ...args]);
      if (existing.exitCode !== 1) throw new Error("owned rule must be provably absent before insertion");
      await checked(execute, "sudo", ["iptables", "-w", "5", "-I", "FORWARD", "1", ...args]);
      receipt.inserted.push(direction);
      await checked(execute, "sudo", ["iptables", "-w", "5", "-C", "FORWARD", ...args]);
    }
    return receipt;
  } catch (error) {
    try { await cleanupIncusForwarding(receipt, identity, execute); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Incus forwarding setup and cleanup failed"); }
    throw error;
  }
}
