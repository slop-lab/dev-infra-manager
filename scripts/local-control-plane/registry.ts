/** Repository-only writable registry, separate from the optional pull-through cache. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checked, type Command } from "../local-uninstall/command.ts";
import { object, text } from "../local-uninstall/files.ts";
import { privateDirectory, privateJson, replaceJson } from "./files.ts";
import type { DockerClaim } from "../local-uninstall/types.ts";

const image = "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33";
export function registryClaims(value: unknown): DockerClaim[] {
  const row = object(value), id = text(row.id);
  if (row.schemaVersion !== 1 || Object.keys(row).length !== 2 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error("invalid local image registry ownership");
  return (["container", "volume"] as const).map((kind) => ({ kind, name: `dim-local-images-${id}${kind === "volume" ? "-data" : ""}`,
    labels: { "dim.managed": "true", "dim.local-images": id, "dim.resource": kind } }));
}
export async function ensureLocalImageRegistry(data: string, run: Command): Promise<string> {
  const directory = join(data, "local-install"), file = join(directory, "registry.json");
  await privateDirectory(directory);
  let value = await privateJson(file);
  if (value === undefined) { value = { schemaVersion: 1, id: randomUUID() }; await replaceJson(file, value); }
  const claims = registryClaims(value), container = claims[0]!, volume = claims[1]!;
  async function inspect(claim: DockerClaim): Promise<Record<string, unknown> | undefined> {
    // Docker's filtered listing distinguishes absence from a failed daemon/inspect.
    const name = (await checked(run, "docker", [claim.kind === "volume" ? "volume" : "container", "ls", ...(claim.kind === "container" ? ["--all"] : []), "--filter", `name=^${claim.name}$`, "--format", claim.kind === "container" ? "{{.Names}}" : "{{.Name}}"])).trim();
    if (!name) return;
    if (name !== claim.name) throw new Error("ambiguous local image registry resources");
    const inspected = JSON.parse(await checked(run, "docker", [claim.kind, "inspect", claim.name])) as unknown[];
    const row = object(inspected[0]), labels = object(claim.kind === "volume" ? row.Labels : object(row.Config).Labels);
    if (Object.entries(claim.labels).some(([key, value]) => labels[key] !== value)) throw new Error("foreign local image registry resource");
    return row;
  }
  if (!await inspect(volume)) await checked(run, "docker", ["volume", "create", ...Object.entries(volume.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), volume.name]);
  let existing = await inspect(container);
  if (!existing) {
    await checked(run, "docker", ["run", "--detach", "--name", container.name, "--restart", "unless-stopped", "--publish", "127.0.0.1::5000",
      ...Object.entries(container.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--mount", `type=volume,src=${volume.name},dst=/var/lib/registry`, "--env", "OTEL_TRACES_EXPORTER=none", image]);
    existing = await inspect(container);
  }
  if (!existing) throw new Error("local image registry disappeared");
  const config = object(existing.Config), host = object(existing.HostConfig);
  const mounts = existing.Mounts as Record<string, unknown>[];
  const bindings = object(host.PortBindings), publication = bindings["5000/tcp"] as Record<string, unknown>[];
  if (config.Image !== image || host.Privileged !== false || host.NetworkMode === "host" || host.PidMode === "host"
    || !Array.isArray(mounts) || mounts.length !== 1 || mounts[0]?.Name !== volume.name || mounts[0]?.Destination !== "/var/lib/registry"
    || Object.keys(bindings).length !== 1 || !Array.isArray(publication) || publication.length !== 1 || publication[0]?.HostIp !== "127.0.0.1") throw new Error("local image registry runtime configuration changed");
  if (object(existing.State).Running !== true) await checked(run, "docker", ["container", "start", text(existing.Id)]);
  const ports = JSON.parse(await checked(run, "docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", text(existing.Id)])) as Record<string, { HostIp: string; HostPort: string }[]>;
  const address = ports["5000/tcp"];
  if (address?.length !== 1 || address[0]?.HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(address[0].HostPort)) throw new Error("local image registry is not loopback-only");
  const endpoint = `127.0.0.1:${address[0].HostPort}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`http://${endpoint}/v2/`, { signal: AbortSignal.timeout(1000) })).status === 200) return endpoint; } catch { /* readiness retry */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("local image registry did not become ready");
}
