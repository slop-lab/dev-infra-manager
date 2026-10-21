import { checked, type Command } from "./command.ts";
import { object, text } from "./files.ts";
import type { DockerClaim } from "./types.ts";
export interface DockerResource { readonly claim: DockerClaim; readonly id: string; readonly created: string }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("invalid Docker inspection array"); return value; }
function labels(info: Record<string, unknown>, claim: DockerClaim) { return object(claim.kind === "container" ? object(info.Config).Labels : info.Labels); }
export async function inspectDocker(run: Command, claim: DockerClaim): Promise<Record<string, unknown> | undefined> {
  // Listing separates absence from permission/daemon/transport failures.
  const ids = (await checked(run, "docker", [claim.kind, "ls", ...(claim.kind === "container" ? ["--all", "--no-trunc"] : []), "--format", "{{json .}}"])).trim().split("\n").filter(Boolean);
  const exists = ids.some((line) => { const row = object(JSON.parse(line) as unknown); return row.Name === claim.name || row.Names === claim.name; });
  if (!exists) return undefined;
  const info = object(array(JSON.parse(await checked(run, "docker", [claim.kind, "inspect", claim.name])))[0]);
  const actualName = claim.kind === "container" ? text(info.Name).replace(/^\//, "") : text(info.Name);
  const actual = labels(info, claim);
  if (actualName !== claim.name || Object.entries(claim.labels).some(([key, value]) => actual[key] !== value)) throw new Error(`ownership mismatch: Docker ${claim.kind} ${claim.name}`);
  return info;
}
function resource(claim: DockerClaim, info: Record<string, unknown>): DockerResource {
  return { claim, id: claim.kind === "volume" ? text(info.Name) : text(info.Id), created: text(info.Created ?? info.CreatedAt) };
}
export async function planDocker(run: Command, claims: readonly DockerClaim[]): Promise<DockerResource[]> {
  const unique = new Map<string, DockerClaim>();
  for (const claim of claims) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(claim.name) || Object.keys(claim.labels).length === 0) throw new Error("invalid Docker removal claim");
    const key = `${claim.kind}:${claim.name}`, previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(claim)) throw new Error(`conflicting ownership claims: ${claim.name}`);
    unique.set(key, claim);
  }
  const selected: DockerResource[] = [], infos = new Map<string, Record<string, unknown>>();
  for (const claim of unique.values()) {
    const info = await inspectDocker(run, claim);
    if (info) { selected.push(resource(claim, info)); infos.set(`${claim.kind}:${claim.name}`, info); }
  }
  for (const item of selected) if (item.claim.requiresContainer) {
    const anchor = infos.get(`container:${item.claim.requiresContainer}`);
    if (!anchor || !array(anchor.Mounts).some((entry) => { const mount = object(entry); return mount.Type === "volume" && mount.Name === item.claim.name; })) {
      throw new Error(`cannot authorize volume ${item.claim.name} without its owned Caddy container`);
    }
  }
  await assertNoForeignUsers(run, selected);
  return selected;
}
export async function assertNoForeignUsers(run: Command, selected: readonly DockerResource[]): Promise<void> {
  const containers = new Set(selected.filter(({ claim }) => claim.kind === "container").map(({ id }) => id));
  for (const { claim } of selected) if (claim.kind !== "container") {
    const users = (await checked(run, "docker", ["container", "ls", "--all", "--no-trunc", "--filter", `${claim.kind}=${claim.name}`, "--format", "{{.ID}}"])).trim().split("\n").filter(Boolean);
    if (users.some((id) => !containers.has(id))) throw new Error(`foreign container uses Docker ${claim.kind} ${claim.name}; nothing removed`);
  }
}
export async function removeDocker(run: Command, selected: readonly DockerResource[], retainedVolumes: readonly string[] = []): Promise<void> {
  // Recheck the whole snapshot before mutation; state journals remain until every resource is gone.
  for (const item of selected) {
    const actual = await inspectDocker(run, item.claim);
    if (actual && JSON.stringify(resource(item.claim, actual)) !== JSON.stringify(item)) throw new Error(`Docker identity changed: ${item.claim.name}`);
  }
  await assertNoForeignUsers(run, selected);
  for (const kind of ["container", "volume", "network"] as const) for (const item of selected.filter(({ claim }) => claim.kind === kind)) {
    if (kind === "volume" && retainedVolumes.includes(item.claim.name)) continue;
    const actual = await inspectDocker(run, item.claim);
    if (!actual) continue;
    if (JSON.stringify(resource(item.claim, actual)) !== JSON.stringify(item)) throw new Error(`Docker identity changed: ${item.claim.name}`);
    await checked(run, "docker", [kind, "rm", ...(kind === "container" ? ["--force", "--volumes"] : []), item.id]);
  }
}
