import { CONTROL_NETWORK } from "./registryCache.js";
import { UserError } from "./errors.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export const GITEA_CONTAINER = "dim-gitea";
export const GITEA_NETWORK = CONTROL_NETWORK;
export const GITEA_VOLUME = "dim-gitea-data";
const GITEA_CONFIG_PATH = "/data/gitea/conf/app.ini";
const ORGANIZATION_POLICY_ENV = "GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true";

export type GiteaContainer = {
  readonly id: string;
  readonly running: boolean;
};

type ResourcePlan = {
  readonly type: "network" | "volume";
  readonly inspectArgs: readonly string[];
  readonly createArgs: readonly string[];
  readonly name: string;
};

const missingResourceDiagnostic = {
  network: (name: string) => `Error response from daemon: network ${name} not found`,
  volume: (name: string) => `Error response from daemon: get ${name}: no such volume`
} as const satisfies Record<ResourcePlan["type"], (name: string) => string>;

export function giteaContainerCreationArgs(
  options: LifecycleOptions,
  publishAddress: string,
  rootUrl: string
): string[] {
  return [
    "run", "--detach",
    "--name", GITEA_CONTAINER,
    "--restart", "unless-stopped",
    "--network", GITEA_NETWORK,
    "--network-alias", "dim-gitea",
    "--publish", `${publishAddress}:${options.giteaPort}:3000`,
    "--mount", `type=volume,source=${GITEA_VOLUME},target=/data`,
    "--label", "dim.managed=true",
    "--label", "dim.resource=gitea",
    "--env", "GITEA__database__DB_TYPE=sqlite3",
    "--env", "GITEA__server__DISABLE_SSH=true",
    "--env", `GITEA__server__ROOT_URL=${rootUrl}/`,
    "--env", "GITEA__service__DISABLE_REGISTRATION=true",
    "--env", ORGANIZATION_POLICY_ENV,
    "--env", "GITEA__security__INSTALL_LOCK=true",
    options.giteaImage
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

export async function inspectGiteaContainer(runner: CommandRunner): Promise<GiteaContainer | undefined> {
  const inspected = await runner.run("docker", [
    "container", "inspect", GITEA_CONTAINER,
    "--format", "{{.Id}}|{{index .Config.Labels \"dim.managed\"}}|{{.State.Running}}"
  ]);
  if (inspected.exitCode !== 0) {
    const diagnostic = inspected.stderr.trim();
    if ([
      `Error: No such container: ${GITEA_CONTAINER}`,
      `Error: No such object: ${GITEA_CONTAINER}`,
      `Error response from daemon: No such container: ${GITEA_CONTAINER}`,
      `Error response from daemon: No such object: ${GITEA_CONTAINER}`
    ].includes(diagnostic)) return undefined;
    throw new UserError(`Failed to inspect Gitea container: ${diagnostic}`);
  }
  const fields = inspected.stdout.trim().split("|");
  const [id, managed, running] = fields;
  if (fields.length !== 3 || id === undefined || id.length === 0 || managed !== "true"
    || (running !== "true" && running !== "false")) {
    throw new UserError(`Docker resource '${GITEA_CONTAINER}' exists but is not managed by dim`);
  }
  return { id, running: running === "true" };
}

export async function ensureGiteaBaseResources(runner: CommandRunner): Promise<void> {
  await ensureResource(runner, {
    type: "network",
    inspectArgs: ["network", "inspect", GITEA_NETWORK, "--format", "{{index .Labels \"dim.managed\"}}"],
    createArgs: ["network", "create", "--label", "dim.managed=true", "--label", "dim.resource=network", GITEA_NETWORK],
    name: GITEA_NETWORK
  });
  await ensureResource(runner, {
    type: "volume",
    inspectArgs: ["volume", "inspect", GITEA_VOLUME, "--format", "{{index .Labels \"dim.managed\"}}"],
    createArgs: ["volume", "create", "--label", "dim.managed=true", "--label", "dim.resource=gitea-data", GITEA_VOLUME],
    name: GITEA_VOLUME
  });
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

async function ensureResource(runner: CommandRunner, plan: ResourcePlan): Promise<void> {
  const inspected = await runner.run("docker", [...plan.inspectArgs]);
  if (inspected.exitCode === 0) {
    if (inspected.stdout.trim() !== "true") {
      throw new UserError(`Docker resource '${plan.name}' exists but is not managed by dim`);
    }
    return;
  }
  if (inspected.stderr.trim().toLowerCase() !== missingResourceDiagnostic[plan.type](plan.name).toLowerCase()) {
    throw new UserError(
      `Failed to inspect Docker ${plan.type} '${plan.name}': stderr: ${inspected.stderr.trim()}; stdout: ${inspected.stdout.trim()}`
    );
  }
  assertCommand(await runner.run("docker", [...plan.createArgs]), `create Docker ${plan.createArgs[0]}`);
}

function assertCommand(result: { readonly exitCode: number; readonly stdout?: string; readonly stderr: string }, action: string): void {
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}
