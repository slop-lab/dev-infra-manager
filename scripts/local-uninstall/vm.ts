import { checked, type Command } from "./command.ts";
import { object } from "./files.ts";
import type { VmClaim } from "./host-resources.ts";
export async function inspectVm(run: Command, claim: VmClaim): Promise<boolean> {
  const list: unknown = JSON.parse(await checked(run, "incus", ["list", "--project", claim.project, "--format=json"]));
  if (!Array.isArray(list)) throw new Error("invalid Incus instance list");
  const instance = list.map(object).find((value) => value.name === claim.name);
  if (!instance) return false;
  const config = object(instance.config);
  if (instance.type !== "virtual-machine" || config["user.dim.workspace-id"] !== claim.id || config["user.dim.owner"] !== "dim-vm-v1"
    || config["user.dim.image"] !== claim.image || config["volatile.base_image"] !== claim.image) throw new Error(`foreign Incus instance: ${claim.project}/${claim.name}`);
  return true;
}
export async function removeVms(run: Command, claims: readonly VmClaim[]): Promise<void> {
  for (const claim of claims) if (await inspectVm(run, claim)) await checked(run, "incus", ["delete", "--project", claim.project, claim.name, "--force"]);
}
