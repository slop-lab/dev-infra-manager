import { randomUUID } from "node:crypto";
import { DIM_PLUGIN_API_VERSION, requireControllerWorkspace, workspacePluginRequest, type AdminRouteContext, type ControllerRouteContext, type ControllerRuntimeContext, type ControllerWorkspace, type DimPlugin, type DimPluginHost, type ResolvedWorkspaceTarget, type WorkspaceTarget } from "@slop-lab/dim-host-core/controller";
import { UserError } from "@slop-lab/dim-host-core";
import {
  readExternalUrlConfig,
  writeExternalUrlConfig,
  type ExternalUrlIngressConfig, type ExternalUrlConfig
} from "@slop-lab/dim-contracts-external-url";
import { caddyIngressDriver } from "./caddyRuntime.js";
import { httpIngressDriver } from "./httpAdapter.js";
import { dnsDriver, normalizeDnsProviderArgument } from "./dnsProvider.js";
import { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, ingressDriver, type ExternalUrlIngressRuntime } from "./ingressDriver.js";
export { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, type ExternalUrlIngressDriver, type ExternalUrlIngressRuntime } from "./ingressDriver.js";
import { ingressPolicyRevision } from "./approvalPolicy.js";
import {
  WorkspaceIngressListener,
  type HttpIngressRequest
} from "./httpIngress.js";
import { WorkspaceRouteRegistry } from "./httpRouteRegistry.js";
import {
  parseRoutePolicy,
  workspaceSubdomainPrefix,
  type ExternalUrlRoutePolicyConfig
} from "./routePolicy.js";
import {
  deduplicateRoutes,
  ExternalUrlStore,
  hostUrlList,
  publicEntries,
  publicEntry,
  type ExternalUrlApproval,
  type ExternalRoute,
  type StoredUrl
} from "./routeStore.js";
import { TcpIngressListener } from "./tcpIngress.js";
import { tailscaleIngressDriver } from "./tailscale.js";

export { TcpIngressListener } from "./tcpIngress.js";
export { tailscaleIngressDriver } from "./tailscale.js";

export interface ExternalUrlIngressOptions {
  description: string;
  scheme: "http" | "https" | "tcp";
  domain: string;
  port?: number;
  listenHost: string;
  listenPort: number;
  routePolicy?: ExternalUrlRoutePolicyConfig;
  approvalRequired?: boolean;
  approvalExposure?: {
    readonly listenHost: string;
    readonly listenPort: number;
  };
}

export interface ExternalUrlsPluginOptions {
  ingresses: Readonly<Record<string, ExternalUrlIngressOptions>>;
  initialize?(runtime: ControllerRuntimeContext): Promise<void>;
}

type NormalizedRequest = HttpIngressRequest;

interface IngressListener {
  name: string;
  provision(
    workspace: ControllerWorkspace,
    request: NormalizedRequest,
    upstream: ResolvedWorkspaceTarget | undefined,
    routeId?: string,
    approval?: ExternalUrlApproval,
    publicRouteId?: string,
    resolve?: () => Promise<ResolvedWorkspaceTarget>
  ): Promise<{ readonly route: ExternalRoute; readonly acquired: boolean }>;
  revoke(route: ExternalRoute): Promise<void>;
  setApproval(route: ExternalRoute, enabled: boolean): void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

interface ConfiguredIngress {
  options: ExternalUrlIngressOptions;
  listener: IngressListener;
  policyRevision: string;
}

interface RouteReconciliationContext {
  workspace: ControllerWorkspace;
  resolveTarget(target: WorkspaceTarget): Promise<ResolvedWorkspaceTarget>;
}

export function createExternalUrlsPlugin(configuration: ExternalUrlsPluginOptions | ((host: DimPluginHost) => Promise<ExternalUrlsPluginOptions>)): DimPlugin {
  if (typeof configuration !== "function") validateOptions(configuration);

  return {
    name: "@slop-lab/dim-host-plugin-external-urls",
    apiVersion: DIM_PLUGIN_API_VERSION,
    async register(host) {
      host.registerExtension(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, "http", httpIngressDriver);
      host.registerExtension(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, "caddy", caddyIngressDriver);
      host.registerExtension(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, "tailscale", tailscaleIngressDriver);
      let options: ExternalUrlsPluginOptions = typeof configuration === "function" ? { ingresses: {} } : configuration;
      let prepared = false;
      const registry = new WorkspaceRouteRegistry();
      const mutations = new RouteMutationQueue();
      const ingresses = new Map<string, ConfiguredIngress>();
      host.registerAdminRoute({
        method: "POST",
        path: "/external-url/:action",
        summary: "Manage External URL DNS providers, ingresses, and host route inventory",
        async handle(context) {
          return {
            body: await mutations.run(() => externalUrlAdmin(
              host, context, ingresses, context.params.action ?? "", context.readJson()
            ))
          };
        }
      });
      const prepare = async () => {
        if (prepared) return;
        if (typeof configuration === "function") options = await configuration(host);
        validateOptions(options);
        try {
          for (const [name, ingress] of Object.entries(options.ingresses)) {
            ingresses.set(name, {
              options: ingress,
              policyRevision: ingressPolicyRevision(name, ingress),
              listener: ingress.scheme === "tcp"
                ? new TcpIngressListener({
                    name,
                    authorizeWorkspace: async (workspace) => { await requireControllerWorkspace(workspace); },
                    listenHost: ingress.listenHost,
                    listenPort: ingress.listenPort,
                    publicHost: ingress.domain,
                  })
                : new WorkspaceIngressListener(registry, {
                    name,
                    authorizeWorkspace: async (workspace) => { await requireControllerWorkspace(workspace); },
                    listenHost: ingress.listenHost,
                    listenPort: ingress.listenPort,
                    scheme: ingress.scheme,
                    domain: ingress.domain,
                    ...(ingress.routePolicy === undefined ? {} : { routePolicy: ingress.routePolicy }),
                    ...(ingress.port === undefined ? {} : { port: ingress.port })
                  }, host.logger)
            });
          }
          await Promise.all([...ingresses.values()].map((ingress) => ingress.listener.ready()));
          prepared = true;
        } catch (error) {
          await Promise.allSettled([...ingresses.values()].map((ingress) => ingress.listener.close()));
          throw error;
        }
      };
      try {
        if (typeof configuration !== "function") await prepare();
        const initialize = async (runtime: ControllerRuntimeContext): Promise<void> => {
          try {
            await prepare();
            await options.initialize?.(runtime);
            const store = new ExternalUrlStore(runtime.stateRoot);
            for (const workspace of await runtime.listWorkspaces()) {
              for (const entry of deduplicateRoutes(await store.list(workspace.id))) {
                try {
                  await runtime.runWorkspaceRequest(workspace, () => reconcileStoredRoute(
                    entry,
                    required(ingresses, entry.ingress),
                    store,
                    {
                      workspace,
                      resolveTarget: (target) => runtime.resolveTarget(workspace, target)
                    }
                  ));
                } catch (error) {
                  host.logger.error("DIM external URL route reconciliation failed", {
                    workspace: workspace.name,
                    route: entry.route.id,
                    ingress: entry.ingress,
                    error: error instanceof Error ? error.message : String(error)
                  });
                }
              }
            }
          } catch (error) {
            await Promise.allSettled([...ingresses.values()].map((ingress) => ingress.listener.close()));
            throw error;
          }
        };

        const discovery = {
          get ingresses() { return Object.entries(options.ingresses).map(([name, ingress]) => ({
            name,
            description: ingress.description,
            scheme: ingress.scheme
          })); },
          target: {
            containers: "zero or one workspace container name",
            maxDepth: 1
          }
        };
        host.registerControllerRoute({
          method: "GET",
          path: "/urls",
          summary: "List external URLs for this workspace",
          discovery,
          initialize,
          handle: (context) => mutations.run(() => listUrls(context, ingresses))
        });
        host.registerControllerRoute({
          method: "POST",
          path: "/urls",
          summary: "Create an external URL using a host-configured ingress",
          discovery,
          handle: (context) => mutations.run(() => createUrl(context, ingresses))
        });
        host.registerControllerRoute({
          method: "DELETE",
          path: "/urls",
          summary: "Revoke every external URL for this workspace",
          handle: (context) => mutations.run(() => deleteWorkspaceUrls(context, ingresses))
        });
        host.registerControllerRoute({
          method: "DELETE",
          path: "/urls/:id",
          summary: "Revoke an external URL",
          handle: (context) => mutations.run(() => deleteUrl(context, ingresses))
        });

        return async () => Promise.all([...ingresses.values()].map((ingress) => ingress.listener.close())).then(() => {});
      } catch (error) {
        await Promise.allSettled([...ingresses.values()].map((ingress) => ingress.listener.close()));
        throw error;
      }
    }
  };
}

export async function externalUrlsPluginFromConfig(env: NodeJS.ProcessEnv = process.env): Promise<DimPlugin> {
  const config = await readExternalUrlConfig(env);
  return createExternalUrlsPlugin(async (host) => {
    const ingresses: Record<string, ExternalUrlIngressOptions> = {};
    const prepared = new Map<string, ExternalUrlIngressRuntime>();
    // Resolution happens after all controller plugins have registered their drivers.
    for (const [name, ingress] of Object.entries(config.ingresses)) {
      const runtime = await ingressDriver(host, ingress.driver).runtime(ingress.argument, { host, config }, ingress.scheme);
      if (runtime.scheme !== ingress.scheme) throw new UserError(`ingress '${name}' runtime scheme differs from its configured scheme`);
      const { initialize: _initialize, ...endpoint } = runtime;
      ingresses[name] = { ...endpoint, description: ingress.description,
        ...(ingress.approvalRequired === undefined ? {} : { approvalRequired: ingress.approvalRequired }) };
      prepared.set(name, runtime);
    }
    return { ingresses, async initialize(runtime) {
      for (const driver of host.extensionsOfKind<import("./ingressDriver.js").ExternalUrlIngressDriver>(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION)) {
        const names = new Set(Object.entries(config.ingresses).filter(([, ingress]) => ingressDriver(host, ingress.driver) === driver).map(([name]) => name));
        await driver.prune?.(runtime, names);
      }
      for (const [name, ingress] of prepared) await ingress.initialize?.(runtime, name);
    } };
  });
}

async function externalUrlAdmin(
  host: DimPluginHost,
  context: AdminRouteContext,
  ingresses: Map<string, ConfiguredIngress>,
  action: string,
  pendingValue: Promise<unknown>
): Promise<unknown> {
  const value = await pendingValue;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  const text = (name: string) => {
    const result = input[name];
    if (typeof result !== "string") throw new UserError(`${name} must be a string`);
    return result;
  };
  const strings = (name: string) => {
    const result = input[name];
    if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
      throw new UserError(`${name} must be an array of strings`);
    }
    return result as string[];
  };
  if (action === "url-list") return hostUrlList(context.lifecycle.stateRoot);
  const config = await readExternalUrlConfig();
  switch (action) {
    case "url-approve":
      return transitionRouteApproval(context.lifecycle.stateRoot, ingresses, text("id"), "approved");
    case "url-revoke":
      return transitionRouteApproval(context.lifecycle.stateRoot, ingresses, text("id"), "revoked");
    case "dns-provider-add": {
      const driver = text("driver");
      const implementation = dnsDriver(host, driver);
      if (typeof implementation.parseProviderArguments !== "function") {
        throw new UserError(`external URL DNS provider driver '${driver}' does not expose CLI arguments`);
      }
      config.dnsProviders[text("name")] = {
        driver,
        argument: normalizeDnsProviderArgument(
          host,
          driver,
          implementation.parseProviderArguments(strings("arguments"))
        )
      };
      await writeExternalUrlConfig(config);
      return {};
    }
    case "dns-provider-list":
      return Object.entries(config.dnsProviders).map(([name, provider]) => ({
        name,
        driver: provider.driver
      }));
    case "dns-provider-remove": {
      const name = text("name");
      if (!config.dnsProviders[name]) throw new UserError(`DNS provider '${name}' is not configured`);
      const dependent = Object.entries(config.ingresses)
        .find(([, ingress]) => ingressDriver(host, ingress.driver).dependencies?.(ingress.argument).includes(name));
      if (dependent) throw new UserError(`DNS provider '${name}' is used by ingress '${dependent[0]}'`);
      delete config.dnsProviders[name];
      await writeExternalUrlConfig(config);
      return {};
    }
    case "ingress-add": {
      const driver = text("driver");
      const scheme = text("scheme");
      if (scheme !== "http" && scheme !== "https" && scheme !== "tcp") {
        throw new UserError("scheme must be http, https, or tcp");
      }
      const argument = await ingressDriver(host, driver).configure(scheme, strings("arguments"), { host, config });
      if (input.approvalRequired !== undefined && typeof input.approvalRequired !== "boolean") {
        throw new UserError("approvalRequired must be a boolean");
      }
      const ingress: ExternalUrlIngressConfig = {
        driver,
        description: text("description"),
        scheme,
        argument,
        approvalRequired: input.approvalRequired === true
      };
      config.ingresses[text("name")] = ingress;
      await writeExternalUrlConfig(config);
      return {};
    }
    case "ingress-list":
      return Object.entries(config.ingresses).map(([name, ingress]) => ({ name, ...ingress }));
    case "ingress-remove": {
      const name = text("name");
      const ingress = config.ingresses[name];
      if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
      const implementation = ingressDriver(host, ingress.driver);
      if (input.cleanupDns === true && implementation.remove === undefined) throw new UserError(`ingress '${name}' does not have provider-managed DNS`);
      await implementation.remove?.(name, ingress.argument, context, { host, config }, input.cleanupDns === true);
      const configured = ingresses.get(name);
      if (configured !== undefined) {
        await configured.listener.close();
        ingresses.delete(name);
      }
      await new ExternalUrlStore(context.lifecycle.stateRoot).removeIngress(name);
      delete config.ingresses[name];
      await writeExternalUrlConfig(config);
      return {};
    }
    case "ingress-verify": {
      const name = text("name");
      const ingress = config.ingresses[name];
      if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
      await ingressDriver(host, ingress.driver).verify(ingress.argument, { host, config });
      return {};
    }
    default: throw new UserError(`unknown External URL admin action '${action}'`);
  }
}

async function transitionRouteApproval(
  stateRoot: string,
  ingresses: ReadonlyMap<string, ConfiguredIngress>,
  id: string,
  approval: "approved" | "revoked"
): Promise<{ readonly urls: readonly Record<string, unknown>[] }> {
  const store = new ExternalUrlStore(stateRoot);
  const entry = await store.current(id);
  if (entry === undefined) throw new UserError(`external URL '${id}' not found`);
  const ingress = required(ingresses, entry.ingress);
  if (approval === "approved") {
    if (entry.approval !== "pending") {
      throw new UserError(`external URL '${id}' is ${entry.approval} and cannot be approved`);
    }
    if (entry.policyRevision !== ingress.policyRevision) {
      throw new UserError(`external URL '${id}' approval does not match the current ingress policy`);
    }
    ingress.listener.setApproval(entry.route, false);
    const updated = { ...entry, approval } satisfies StoredUrl;
    await store.put(updated);
    ingress.listener.setApproval(entry.route, true);
    return { urls: [publicEntry(updated)] };
  }
  if (entry.approval === "revoked") return { urls: [publicEntry(entry)] };
  const updated = { ...entry, approval } satisfies StoredUrl;
  await store.put(updated);
  await ingress.listener.revoke(entry.route);
  return { urls: [publicEntry(updated)] };
}

async function listUrls(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const store = new ExternalUrlStore(context.stateRoot);
  const entries = await store.list(context.workspace.id);
  const reconciled = new Map<string, StoredUrl>();
  for (const entry of deduplicateRoutes(entries)) {
    reconciled.set(entry.id, await reconcileStoredRoute(entry, required(ingresses, entry.ingress), store, context));
  }
  return {
    body: {
      urls: publicEntries(entries.map((entry) => reconciled.get(entry.id) ?? entry))
    }
  };
}

async function reconcileStoredRoute(
  entry: StoredUrl,
  ingress: ConfiguredIngress,
  store: ExternalUrlStore,
  context: RouteReconciliationContext
): Promise<StoredUrl> {
  if (entry.approval === "revoked") return entry;
  const missingPermalink = entry.subdomain !== undefined
    && (entry.permalink === undefined || entry.route.permalinkAuthority === undefined);
  const policyChanged = entry.policyRevision !== ingress.policyRevision;
  const approvalChanged = ingress.options.approvalRequired === true && (policyChanged || missingPermalink);
  const current = approvalChanged
    ? { ...entry, approval: "pending" as const }
    : entry;
  if (approvalChanged) {
    await store.put(current);
  }
  // Restore the approved route identity even when its runtime is currently
  // stopped or absent. Every new flow must resolve current ownership before
  // connecting; no cached or placeholder address is used for deferred routes.
  let upstream: ResolvedWorkspaceTarget | undefined;
  try { upstream = await context.resolveTarget(current.target); } catch { upstream = undefined; }
  const reconciled = await ingress.listener.provision(
    context.workspace,
    storedRequest(current),
    upstream,
    current.route.ingressId ?? current.id,
    current.approval,
    current.subdomain === undefined ? undefined : current.id,
    () => context.resolveTarget(current.target)
  );
  if (!policyChanged && !missingPermalink) {
    if (reconciled.route.authority === current.route.authority
      && reconciled.route.permalinkAuthority === current.route.permalinkAuthority) return current;
    if (reconciled.acquired) await ingress.listener.revoke(reconciled.route).catch(() => {});
    throw new Error(`external route '${current.route.id}' changed authority during reconciliation`);
  }
  const url = reconciled.route.url;
  if (url === undefined) {
    if (reconciled.acquired) await ingress.listener.revoke(reconciled.route).catch(() => {});
    throw new Error(`ingress '${current.ingress}' did not return a public URL`);
  }
  const permalink = reconciled.route.permalink;
  if (current.subdomain !== undefined && permalink === undefined) {
    if (reconciled.acquired) await ingress.listener.revoke(reconciled.route).catch(() => {});
    throw new Error(`ingress '${current.ingress}' did not return a permalink URL`);
  }
  const updated = {
    ...current,
    route: reconciled.route,
    url,
    ...(permalink === undefined ? {} : { permalink }),
    policyRevision: ingress.policyRevision
  };
  try {
    await store.put(updated);
    return updated;
  } catch (error) {
    if (reconciled.acquired) await ingress.listener.revoke(reconciled.route).catch(() => {});
    throw error;
  }
}

async function createUrl(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const input = await context.readJson() as Record<string, unknown>;
  const ingressName = requestIngress(input);
  const ingress = required(ingresses, ingressName);
  const store = new ExternalUrlStore(context.stateRoot);
  const entries = await store.list(context.workspace.id);
  if (ingress.options.scheme !== "tcp" && input.subdomain === undefined) {
    const used = new Set(entries.flatMap((entry) => entry.subdomain === undefined ? [] : [entry.subdomain]));
    let index = 0;
    const prefix = workspaceSubdomainPrefix(context.workspace.name);
    while (used.has(`${prefix}${index}`)) index += 1;
    input.subdomain = `${prefix}${index}`;
  }
  const request = validateRequest(input, ingress.options.scheme);
  const existing = entries.find((entry) => entry.approval !== "revoked" && requestsEqual(storedRequest(entry), request));
  if (existing !== undefined) {
    const reconciled = await reconcileStoredRoute(existing, ingress, store, context);
    return { status: 200, body: { urls: [publicEntry(reconciled)] } };
  }
  const upstream = await context.resolveTarget(request.target);
  const id = randomUUID();
  const approval: ExternalUrlApproval = ingress.options.approvalRequired === true ? "pending" : "not-required";
  const claim = approval === "not-required" ? routeClaim(context.workspace, request) : id;
  const provisioned = await ingress.listener.provision(
    context.workspace,
    request,
    upstream,
    claim,
    approval,
    request.subdomain === undefined ? undefined : id,
    () => context.resolveTarget(request.target)
  );
  try {
    const { route } = provisioned;
    const url = route.url;
    if (!url) throw new Error(`ingress '${request.ingress}' did not return a public URL`);
    const permalink = route.permalink;
    if (request.subdomain !== undefined && permalink === undefined) {
      throw new Error(`ingress '${request.ingress}' did not return a permalink URL`);
    }
    const entry: StoredUrl = {
      id,
      workspace: context.workspace.name,
      workspaceId: context.workspace.id,
      ingress: request.ingress,
      ...(request.subdomain === undefined ? {} : { subdomain: request.subdomain }),
      target: request.target,
      ...(request.path === undefined ? {} : { path: request.path }),
      route,
      url,
      ...(permalink === undefined ? {} : { permalink }),
      approval,
      policyRevision: ingress.policyRevision,
      createdAt: new Date().toISOString()
    };
    await store.put(entry);
    return { status: 201, body: { urls: [publicEntry(entry)] } };
  } catch (error) {
    if (provisioned.acquired) await ingress.listener.revoke(provisioned.route).catch(() => {});
    throw error;
  }
}

async function deleteUrl(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const store = new ExternalUrlStore(context.stateRoot);
  const entries = await store.list(context.workspace.id);
  const entry = entries.find((candidate) => candidate.id === context.params.id);
  if (!entry) return { status: 404, body: { error: "external URL not found" } };
  const ingress = required(ingresses, entry.ingress);
  const revoked = { ...entry, approval: "revoked" as const };
  await store.put(revoked);
  await ingress.listener.revoke(entry.route);
  await store.remove(revoked);
  return { status: 204 };
}

async function deleteWorkspaceUrls(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  await removeWorkspaceRoutes({
    workspaceId: context.workspace.id,
    stateRoot: context.stateRoot
  }, ingresses);
  return { status: 204 };
}

async function removeWorkspaceRoutes(
  context: { readonly workspaceId: string; readonly stateRoot: string },
  ingresses: ReadonlyMap<string, ConfiguredIngress>
): Promise<void> {
  const store = new ExternalUrlStore(context.stateRoot);
  for (const entry of await store.list(context.workspaceId)) {
    const ingress = ingresses.get(entry.ingress);
    const revoked = { ...entry, approval: "revoked" as const };
    await store.put(revoked);
    if (ingress !== undefined) await ingress.listener.revoke(entry.route);
    await store.remove(revoked);
  }
}

class RouteMutationQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

function validateRequest(value: unknown, scheme: ExternalUrlIngressOptions["scheme"]): NormalizedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  const ingress = requestIngress(input);
  if (scheme === "tcp" && input.subdomain !== undefined) {
    throw new UserError("TCP ingress requests do not accept a subdomain");
  }
  if (scheme !== "tcp" && typeof input.subdomain !== "string") {
    throw new UserError("subdomain must be a relative DNS name");
  }
  if (typeof input.subdomain === "string") validateSubdomain(input.subdomain);
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    throw new UserError("target must be an object");
  }
  const target = input.target as Record<string, unknown>;
  const containers = target.containers ?? [];
  if (!Array.isArray(containers) || containers.length > 1 || !containers.every((name) => typeof name === "string")) {
    throw new UserError("target.containers must contain zero or one workspace container name");
  }
  if (!Number.isInteger(target.port) || (target.port as number) < 1 || (target.port as number) > 65_535) {
    throw new UserError("target.port must be an integer between 1 and 65535");
  }
  if (target.protocol !== undefined && target.protocol !== "http" && target.protocol !== "https"
    && target.protocol !== "tcp") {
    throw new UserError("target.protocol must be http, https, or tcp");
  }
  if (input.path !== undefined && (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.includes(".."))) {
    throw new UserError("path must be an absolute URL path without '..'");
  }
  if (scheme === "tcp" && input.path !== undefined) {
    throw new UserError("TCP ingress requests do not accept a URL path");
  }
  return {
    ingress,
    ...(typeof input.subdomain === "string" ? { subdomain: input.subdomain } : {}),
    target: {
      containers: containers as string[],
      port: target.port as number,
      protocol: (target.protocol ?? (scheme === "tcp" ? "tcp" : "http")) as "http" | "https" | "tcp"
    },
    ...(input.path === undefined ? {} : { path: input.path as string })
  };
}

function requestIngress(input: Readonly<Record<string, unknown>>): string {
  if (typeof input.ingress !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.ingress)) {
    throw new UserError("ingress must be a configured ingress name");
  }
  return input.ingress;
}

function validateOptions(options: ExternalUrlsPluginOptions): void {
  const entries = Object.entries(options.ingresses);
  const domains = new Map<string, {
    name: string;
    routePolicy: string;
    approvalRequired: boolean;
    approvalExposure: string;
  }>();
  for (const [name, ingress] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`invalid external URL ingress '${name}'`);
    if (typeof ingress.description !== "string" || ingress.description.trim().length === 0) {
      throw new Error(`external URL ingress '${name}' requires a description`);
    }
    if (ingress.scheme !== "http" && ingress.scheme !== "https" && ingress.scheme !== "tcp") {
      throw new Error(`external URL ingress '${name}' scheme must be http, https, or tcp`);
    }
    if (typeof ingress.domain !== "string" || normalizeDomain(ingress.domain).length === 0) {
      throw new Error(`external URL ingress '${name}' requires a domain`);
    }
    if (!Number.isInteger(ingress.listenPort) || ingress.listenPort < 0 || ingress.listenPort > 65_535) {
      throw new Error(`external URL ingress '${name}' listenPort must be between 0 and 65535`);
    }
    if (ingress.port !== undefined
      && (!Number.isInteger(ingress.port) || ingress.port < 1 || ingress.port > 65_535)) {
      throw new Error(`external URL ingress '${name}' port must be between 1 and 65535`);
    }
    if (ingress.routePolicy !== undefined) parseRoutePolicy(ingress.routePolicy);
    if (ingress.scheme === "tcp" && (ingress.routePolicy !== undefined || ingress.port !== undefined)) {
      throw new Error(`external URL TCP ingress '${name}' cannot configure HTTP route policy or a separate public port`);
    }
    if (ingress.scheme === "tcp") continue;
    const domain = normalizeDomain(ingress.domain);
    const routing = {
      name,
      routePolicy: JSON.stringify(ingress.routePolicy ?? { driver: "workspace-prefix" }),
      approvalRequired: ingress.approvalRequired === true,
      approvalExposure: JSON.stringify({
        scheme: ingress.scheme,
        port: ingress.port ?? (ingress.scheme === "https" ? 443 : 80),
        listenHost: (ingress.approvalExposure?.listenHost ?? ingress.listenHost).toLowerCase(),
        listenPort: ingress.approvalExposure?.listenPort ?? ingress.listenPort
      })
    };
    const existing = domains.get(domain);
    if (existing && (existing.routePolicy !== routing.routePolicy
      || existing.approvalRequired !== routing.approvalRequired)) {
      throw new Error(
        `external URL ingresses '${existing.name}' and '${name}' share domain '${domain}' `
        + "and must use the same route policy and approval requirement"
      );
    }
    if (existing && routing.approvalRequired && existing.approvalExposure !== routing.approvalExposure) {
      throw new Error(
        `external URL ingresses '${existing.name}' and '${name}' share domain '${domain}' `
        + "and must use the same approval exposure"
      );
    }
    domains.set(domain, routing);
  }
}

function required<T>(values: ReadonlyMap<string, T>, name: string): T {
  const value = values.get(name);
  if (!value) throw new UserError(`external URL ingress '${name}' is not configured`);
  return value;
}

function storedRequest(entry: StoredUrl): NormalizedRequest {
  return {
    ingress: entry.ingress,
    ...(entry.subdomain === undefined ? {} : { subdomain: entry.subdomain }),
    target: entry.target,
    ...(entry.path === undefined ? {} : { path: entry.path })
  };
}

function requestsEqual(left: NormalizedRequest, right: NormalizedRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSubdomain(value: string): void {
  if (value.length === 0 || value.length > 253 || value.endsWith(".")
    || !value.split(".").every((label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new UserError("subdomain must be a lowercase relative DNS name");
  }
}

function routeClaim(workspace: ControllerWorkspace, request: NormalizedRequest): string {
  return [workspace.id, request.ingress, request.subdomain, JSON.stringify(request.target)].join("\u0000");
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}


const plugin: DimPlugin = {
  name: "@slop-lab/dim-host-plugin-external-urls",
  apiVersion: DIM_PLUGIN_API_VERSION,
  async register(host) {
    return (await externalUrlsPluginFromConfig()).register(host);
  }
};

export default plugin;

export { hostPlugin } from "./guest.js";
