import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { packageVersion } from "../package-version.js";
import { UserError, deployGuestIntegration, workspaceEnvironmentSkillAsset, workspaceServiceEndpoint, type WorkspaceRecord, type WorkspaceRuntime } from "../workspace.js";
import type { WorkspaceHostPlugin, WorkspaceHostPluginContext, WorkspaceCapabilityFact } from "../plugin-api.js";
import { hostPluginManifestFingerprint } from "./workspace-agent-state.js";

export interface WorkspaceDiscoveryContext extends WorkspaceHostPluginContext {
  readonly generation: string;
  readonly runtime: WorkspaceRuntime;
}

export interface WorkspaceDiscoveryInput {
  readonly workspace: WorkspaceRecord;
  readonly context: WorkspaceDiscoveryContext;
  readonly plugins: readonly WorkspaceHostPlugin[];
  readonly delivery: "online" | "readiness-cache";
}

export async function workspaceDiscovery(input: WorkspaceDiscoveryInput): Promise<object> {
  const { workspace, context, plugins } = input;
  const observedAt = new Date().toISOString();
  const runtimeStatus = await observeRuntime(workspace, context.runtime);
  const runtimeOwner = plugins.find((plugin) => plugin.runtime?.name === workspace.runtime);
  const isolation = workspace.runtime === "container" ? { kind: "container", owner: "core" }
    : runtimeOwner?.runtime?.isolation === undefined ? { kind: "unknown", owner: runtimeOwner?.name ?? "unavailable" }
    : { kind: runtimeOwner.runtime.isolation, owner: runtimeOwner.name };
  const manifestFingerprint = await hostPluginManifestFingerprint();
  const sourceFingerprint = createHash("sha256").update(JSON.stringify({ ref: workspace.source.ref, commit: workspace.source.commit,
    workingDirectory: workspace.source.workingDirectory ?? null,
    checkouts: (workspace.source.checkouts ?? []).map(({ directory, source }) => ({ directory, ref: source.ref, commit: source.commit })) })).digest("hex");
  const pluginFacts = [];
  const capabilities = [];
  for (const plugin of plugins) {
    const guest = plugin.guest;
    if (guest) {
      const status = await inspectGuest(plugin, workspace, context);
      pluginFacts.push({ owner: plugin.name, description: guest.description, state: status.state,
        ...(status.message === undefined ? {} : { message: status.message }),
        commands: (guest.commands ?? []).map(({ name, description }) => ({ name, description })),
        operations: (guest.operations ?? []).map(({ name, description }) => ({ name, description })) });
    }
    const names = new Set<string>();
    let ownerFacts: readonly WorkspaceCapabilityFact[];
    try {
      ownerFacts = await plugin.workspaceCapabilities?.(workspace, context) ?? [];
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      ownerFacts = [{ name: "provider", description: "Workspace capability provider", state: "unavailable",
        reason: { code: "provider-failed", message: "Capability status could not be inspected" }, access: { kind: "none" } }];
    }
    for (const fact of ownerFacts) {
      validateCapability(plugin, fact, names);
      names.add(fact.name);
      capabilities.push({ owner: plugin.name, name: fact.name, description: fact.description, state: fact.state,
        scope: { kind: "workspace", workspaceId: workspace.id },
        access: publicCapabilityAccess(fact.access),
        ...(fact.reason === undefined ? {} : { reason: { code: fact.reason.code, message: fact.reason.message } }) });
    }
  }
  return {
    schemaVersion: 1,
    delivery: input.delivery,
    host: { hostname: hostname(), version: packageVersion },
    observedAt,
    executionEnvironment: { location: "workspace", boundary: "workspace-runtime", runtime: workspace.runtime,
      runtimeStatus, isolation },
    authorization: { scope: "workspace", workspaceId: workspace.id, transport: "scoped-bearer", acceptsWorkspaceSelector: false },
    agent: { guidance: { name: "dim-environment", provenance: "host-core-built-in",
      version: packageVersion, refresh: "workspace-readiness" } },
    workspace: { id: workspace.id, name: workspace.name, runtime: workspace.runtime, image: workspace.image,
      phase: workspace.phase, updatedAt: workspace.updatedAt, resources: workspace.resources,
      source: { ref: workspace.source.ref, commit: workspace.source.commit,
        freshness: { state: "recorded", recordUpdatedAt: workspace.updatedAt, fingerprint: sourceFingerprint },
        ...(workspace.source.workingDirectory === undefined ? {} : { workingDirectory: workspace.source.workingDirectory }),
        checkouts: (workspace.source.checkouts ?? []).map(({ directory, source }) =>
          ({ directory, ref: source.ref, commit: source.commit })) } },
    freshness: { observedAt, workspaceUpdatedAt: workspace.updatedAt, bridgeGeneration: context.generation,
      pluginManifestFingerprint: manifestFingerprint },
    pluginSet: plugins.map(({ name }) => name),
    services: [{ owner: "core", name: "workspace" }, ...plugins.flatMap((plugin) =>
      (plugin.workspaceServices?.names ?? []).map((name) => ({ owner: plugin.name, name })))],
    serviceEndpoints: [{ owner: "core", name: "workspace", endpoint: workspaceServiceEndpoint("workspace"), availability: "available", readiness: "online",
      authorization: { scope: "workspace", workspaceId: workspace.id } },
      ...plugins.flatMap((plugin) => (plugin.workspaceServices?.names ?? []).map((name) =>
        ({ owner: plugin.name, name, endpoint: workspaceServiceEndpoint(name), availability: "declared", readiness: "not-probed",
          authorization: { scope: "workspace", workspaceId: workspace.id } })))],
    plugins: pluginFacts,
    capabilities,
    developerCapabilities: capabilities.filter(({ state }) => state === "available")
      .map(({ owner, name, access }) => ({ owner, name, access }))
  };
}

function publicCapabilityAccess(access: WorkspaceCapabilityFact["access"]): WorkspaceCapabilityFact["access"] {
  switch (access.kind) {
    case "workspace-local": return { kind: "workspace-local" };
    case "guest-operation": return { kind: "guest-operation", operation: access.operation };
    case "external": return { kind: "external" };
    case "none": return { kind: "none" };
  }
}

async function observeRuntime(workspace: WorkspaceRecord, runtime: Pick<WorkspaceRuntime, "inspect">): Promise<"running" | "stopped" | "missing" | "unavailable"> {
  try {
    const observation = await runtime.inspect(workspace);
    return observation === undefined ? "missing" : observation.running ? "running" : "stopped";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return "unavailable";
  }
}

async function inspectGuest(plugin: WorkspaceHostPlugin, workspace: WorkspaceRecord,
  context: WorkspaceHostPluginContext): Promise<{ readonly state: "ready" | "unconfigured" | "unavailable"; readonly message?: string }> {
  try {
    const value = await plugin.guest?.inspect?.(workspace, context) ?? { state: "ready" as const };
    validateGuestStatus(plugin.name, value);
    return value;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { state: "unavailable", message: "Plugin status could not be inspected" };
  }
}

export async function deployWorkspaceDiscovery(input: Omit<WorkspaceDiscoveryInput, "delivery">): Promise<void> {
  const discovery = await workspaceDiscovery({ ...input, delivery: "readiness-cache" });
  const skill = workspaceEnvironmentSkillAsset();
  await deployGuestIntegration({ service: input.context.service, workspace: input.workspace, signal: input.context.signal }, {
    name: "dim-environment",
    files: [
      { path: ".config/dim/discovery.json", contents: `${JSON.stringify(discovery, null, 2)}\n` },
      { path: ".agents/skills/dim-environment/SKILL.md", contents: await readFile(skill.sourcePath) }
    ]
  });
}

function validateGuestStatus(owner: string, value: unknown): asserts value is { readonly state: "ready" | "unconfigured"; readonly message?: string } {
  if (!isObject(value) || !["ready", "unconfigured"].includes(String(value.state))
    || value.message !== undefined && !description(value.message)) throw new UserError(`invalid guest integration status from '${owner}'`);
}

function validateCapability(plugin: WorkspaceHostPlugin, fact: WorkspaceCapabilityFact, names: Set<string>): void {
  if (!capabilityName(fact.name) || names.has(fact.name) || !description(fact.description)
    || !["available", "blocked", "unavailable"].includes(fact.state) || !isObject(fact.access)
    || !["workspace-local", "guest-operation", "external", "none"].includes(String(fact.access.kind))) {
    throw new UserError(`invalid or duplicate workspace capability in '${plugin.name}'`);
  }
  if (fact.reason !== undefined && (!isObject(fact.reason) || !reasonCode(fact.reason.code) || !description(fact.reason.message))) {
    throw new UserError(`invalid workspace capability reason in '${plugin.name}'`);
  }
  if (fact.state === "available" && fact.access.kind === "none"
    || fact.state !== "available" && (fact.access.kind !== "none" || fact.reason === undefined)) {
    throw new UserError(`workspace capability state and access disagree in '${plugin.name}'`);
  }
  if (fact.access.kind === "guest-operation") {
    const operation = fact.access.operation;
    if (!identifier(operation) || !plugin.guest?.operations?.some(({ name }) => name === operation)) {
      throw new UserError(`workspace capability in '${plugin.name}' refers to an undeclared guest operation`);
    }
  } else if (Object.keys(fact.access).length !== 1) {
    throw new UserError(`invalid workspace capability access in '${plugin.name}'`);
  }
}

function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value); }
function capabilityName(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9.-]{0,127}$/.test(value); }
function reasonCode(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9.-]{0,127}$/.test(value); }
function description(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2000; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
