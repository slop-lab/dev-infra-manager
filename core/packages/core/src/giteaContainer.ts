import { CONTROL_NETWORK } from "./registryCache.js";
import { UserError } from "./errors.js";
import type { GiteaServiceRecord, LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export const GITEA_CONTAINER = "dim-gitea";
export const GITEA_NETWORK = CONTROL_NETWORK;
export const GITEA_VOLUME = "dim-gitea-data";
const GITEA_CONFIG_PATH = "/data/gitea/conf/app.ini";
const ORGANIZATION_POLICY_ENV = "GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true";

export type GiteaContainer = {
  readonly id: string;
  readonly running: boolean;
  readonly endpointAddress: string;
};

export type GiteaResourceLease = Pick<
  GiteaServiceRecord,
  "serviceId" | "containerOwnershipId" | "networkOwnershipId" | "volumeOwnershipId"
  | "imageId" | "networkId" | "volumeName"
>;

export function giteaContainerCreationArgs(
  options: LifecycleOptions,
  publishAddress: string,
  rootUrl: string,
  lease: GiteaResourceLease,
  endpointAddress?: string
): string[] {
  return [
    "container", "create",
    "--name", GITEA_CONTAINER,
    "--restart", "unless-stopped",
    "--network", GITEA_NETWORK,
    "--network-alias", "dim-gitea",
    ...(endpointAddress === undefined ? [] : ["--ip", endpointAddress]),
    "--publish", `${publishAddress}:${options.giteaPort}:3000`,
    "--mount", `type=volume,source=${GITEA_VOLUME},target=/data`,
    "--label", "dim.managed=true",
    "--label", "dim.owner=dim",
    "--label", `dim.service-id=${lease.serviceId}`,
    "--label", "dim.resource=gitea",
    "--label", `dim.resource-id=${lease.containerOwnershipId}`,
    "--env", "GITEA__database__DB_TYPE=sqlite3",
    "--env", "GITEA__server__DISABLE_SSH=true",
    "--env", `GITEA__server__ROOT_URL=${rootUrl}/`,
    "--env", "GITEA__service__DISABLE_REGISTRATION=true",
    "--env", ORGANIZATION_POLICY_ENV,
    "--env", "GITEA__security__INSTALL_LOCK=true",
    lease.imageId
  ];
}

export function giteaChangePasswordArgs(containerId: string, username: string, password: string): string[] {
  return [
    "exec", "--user", "git", containerId,
    "gitea", "admin", "user", "change-password",
    "--config", GITEA_CONFIG_PATH,
    "--username", username,
    "--password", password,
    "--must-change-password=false"
  ];
}

export function giteaWebhookConfigArgs(containerId: string, hosts: string[]): string[] {
  const value = ["external", ...new Set(hosts)].join(",");
  return [
    "exec",
    "--env", `GITEA__webhook__ALLOWED_HOST_LIST=${value}`,
    "--user", "git",
    containerId,
    "gitea", "config", "edit-ini",
    "--config", GITEA_CONFIG_PATH,
    "--apply-env",
    "--in-place"
  ];
}

export function giteaOrganizationPolicyCheckArgs(containerId: string): string[] {
  const script = `awk '
    /^[[:space:]]*\\[[^]]+\\][[:space:]]*$/ {
      name = $0
      gsub(/[[:space:]]/, "", name)
      section = (name == "[admin]")
      next
    }
    section && /^[[:space:]]*DISABLE_REGULAR_ORG_CREATION[[:space:]]*=/ {
      entries += 1
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      if (value == "true") enabled += 1
    }
    END { print entries == 1 && enabled == 1 ? "true" : "false" }
  ' ${GITEA_CONFIG_PATH}`;
  return ["exec", "--user", "git", containerId, "sh", "-c", script];
}

export function giteaOrganizationPolicyEditArgs(containerId: string): string[] {
  return [
    "exec", "--env", ORGANIZATION_POLICY_ENV, "--user", "git", containerId,
    "gitea", "config", "edit-ini",
    "--config", GITEA_CONFIG_PATH,
    "--apply-env",
    "--in-place"
  ];
}

export async function inspectGiteaContainer(
  runner: CommandRunner,
  lease: GiteaResourceLease,
  target = GITEA_CONTAINER
): Promise<GiteaContainer | undefined> {
  const inspected = await runner.run("docker", [
    "container", "inspect", target,
    "--format", `{{.Id}}|{{index .Config.Labels "dim.managed"}}|{{index .Config.Labels "dim.owner"}}|{{index .Config.Labels "dim.service-id"}}|{{index .Config.Labels "dim.resource"}}|{{index .Config.Labels "dim.resource-id"}}|{{.State.Running}}|{{with index .NetworkSettings.Networks "${GITEA_NETWORK}"}}{{.IPAddress}}|{{.NetworkID}}{{end}}|{{.Image}}|{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}`
  ]);
  if (inspected.exitCode !== 0) {
    const diagnostic = inspected.stderr.trim();
    if ([
      `Error: No such container: ${target}`,
      `Error: No such object: ${target}`,
      `Error response from daemon: No such container: ${target}`,
      `Error response from daemon: No such object: ${target}`
    ].includes(diagnostic)) return undefined;
    throw new UserError(`Failed to inspect Gitea container: ${diagnostic}`);
  }
  const fields = inspected.stdout.trim().split("|");
  const [id, managed, owner, serviceId, resource, resourceId, running, endpointAddress,
    networkId, imageId, mountType, mountName, mountWritable] = fields;
  if (fields.length !== 13 || id === undefined || id.length === 0 || managed !== "true" || owner !== "dim"
    || serviceId !== lease.serviceId || resource !== "gitea" || resourceId !== lease.containerOwnershipId
    || (running !== "true" && running !== "false") || endpointAddress === undefined || endpointAddress.length === 0) {
    throw new UserError(`Docker resource '${GITEA_CONTAINER}' exists but is not managed by dim`);
  }
  if (imageId !== lease.imageId) throw new UserError(`Docker resource '${GITEA_CONTAINER}' uses an unverified image`);
  if (lease.networkId === undefined || networkId !== lease.networkId) {
    throw new UserError(`Docker resource '${GITEA_CONTAINER}' uses an unverified network`);
  }
  if (mountType !== "volume" || mountName !== lease.volumeName || mountWritable !== "true") {
    throw new UserError(`Docker resource '${GITEA_CONTAINER}' uses an unverified data volume mount`);
  }
  return { id, running: running === "true", endpointAddress };
}

export async function ensureGiteaOrganizationPolicy(runner: CommandRunner, containerId: string): Promise<void> {
  if (await hasCanonicalGiteaOrganizationPolicy(runner, containerId)) return;
  assertCommand(
    await runner.run("docker", giteaOrganizationPolicyEditArgs(containerId)),
    "configure Gitea organization policy"
  );
  assertCommand(
    await runner.run("docker", ["restart", containerId]),
    "restart Gitea after organization policy configuration"
  );
  if (!await hasCanonicalGiteaOrganizationPolicy(runner, containerId)) {
    throw new UserError("Gitea organization policy is not canonical after restart");
  }
}

async function hasCanonicalGiteaOrganizationPolicy(runner: CommandRunner, containerId: string): Promise<boolean> {
  const checked = await runner.run("docker", giteaOrganizationPolicyCheckArgs(containerId));
  assertCommand(checked, "inspect Gitea organization policy");
  const current = checked.stdout.trim();
  if (current === "true") return true;
  if (current === "false") return false;
  throw new UserError(`Failed to inspect Gitea organization policy: unexpected output '${current}'`);
}

function assertCommand(result: { readonly exitCode: number; readonly stdout?: string; readonly stderr: string }, action: string): void {
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}
