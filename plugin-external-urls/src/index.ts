import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  DIM_PLUGIN_API_VERSION,
  UserError,
  type AdminRouteContext,
  type ControllerRouteContext,
  type ControllerRuntimeContext,
  type ControllerWorkspace,
  type DimPlugin,
  type DimPluginHost,
  type ResolvedWorkspaceTarget,
  type WorkspaceDiscardContext,
  type WorkspaceTarget
} from "@slop-lab/dim-core";
import {
  readExternalUrlConfig,
  writeExternalUrlConfig,
  EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
  type ExternalUrlDnsProviderDriver,
  type ExternalUrlDnsProviderConfig,
  type ExternalUrlIngressConfig
} from "@slop-lab/dim-contracts-external-url";
import {
  CADDY_INGRESS_DOCUMENTATION_URL,
  parseCaddyIngressArgument,
  renderCaddyDeployment,
  verifyCaddyIngress
} from "./caddy.js";
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
import {
  EXTERNAL_URL_INGRESS_DRIVER_EXTENSION,
  tailscaleIngressDriver,
  type ExternalUrlIngressDriver
} from "./tailscale.js";

export { TcpIngressListener } from "./tcpIngress.js";
export { tailscaleIngressDriver } from "./tailscale.js";

export interface ExternalUrlIngressOptions {
  description: string;
  scheme: "http" | "https" | "tcp";
  domain: string;
  port?: number;
  listenHost: string;
  listenPort: number;
  upstreamMode?: "container-dns" | "container-ip";
  routePolicy?: ExternalUrlRoutePolicyConfig;
  approvalRequired?: boolean;
  approvalExposure?: {
    readonly listenHost: string;
    readonly listenPort: number;
  };
}

export interface ExternalUrlsPluginOptions {
  ingresses: Readonly<Record<string, ExternalUrlIngressOptions>>;
  requiredDnsDrivers?: readonly string[];
  managedCaddy?: Readonly<Record<string, ManagedCaddyIngress>>;
}

interface ManagedCaddyIngress {
  argument: ReturnType<typeof parseCaddyIngressArgument> & { listenPort: number };
  provider: ExternalUrlDnsProviderConfig;
  routerPort: number;
}

type NormalizedRequest = HttpIngressRequest;

interface IngressListener {
  name: string;
  upstreamMode: "container-dns" | "container-ip";
  provision(
    workspace: ControllerWorkspace,
    request: NormalizedRequest,
    upstream: ResolvedWorkspaceTarget,
    routeId?: string,
    approval?: ExternalUrlApproval,
    publicRouteId?: string
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
  resolveTarget(target: WorkspaceTarget, mode: "container-dns" | "container-ip"): Promise<ResolvedWorkspaceTarget>;
}

export function createExternalUrlsPlugin(options: ExternalUrlsPluginOptions): DimPlugin {
  validateOptions(options);

  return {
    name: "@slop-lab/dim-plugin-external-urls",
    apiVersion: DIM_PLUGIN_API_VERSION,
    async register(host) {
      host.registerExtension(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, "tailscale", tailscaleIngressDriver);
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
      host.registerWorkspaceDiscardHook({
        beforeDiscard: (context) => mutations.run(() => removeWorkspaceRoutes(context, ingresses))
      });
      for (const [name, ingress] of Object.entries(options.ingresses)) {
        ingresses.set(name, {
          options: ingress,
          policyRevision: ingressPolicyRevision(name, ingress),
          listener: ingress.scheme === "tcp"
            ? new TcpIngressListener({
                name,
                listenHost: ingress.listenHost,
                listenPort: ingress.listenPort,
                publicHost: ingress.domain,
                upstreamMode: ingress.upstreamMode ?? "container-ip"
              })
            : new WorkspaceIngressListener(registry, {
                name,
                listenHost: ingress.listenHost,
                listenPort: ingress.listenPort,
                upstreamMode: ingress.upstreamMode ?? "container-ip",
                scheme: ingress.scheme,
                domain: ingress.domain,
                ...(ingress.routePolicy === undefined ? {} : { routePolicy: ingress.routePolicy }),
                ...(ingress.port === undefined ? {} : { port: ingress.port })
              }, host.logger)
        });
      }
      await Promise.all([...ingresses.values()].map((ingress) => ingress.listener.ready()));

      const initialize = async (runtime: ControllerRuntimeContext): Promise<void> => {
        for (const driver of options.requiredDnsDrivers ?? []) dnsDriver(host, driver);
        await removeStaleManagedCaddy(runtime, new Set(Object.keys(options.managedCaddy ?? {})));
        for (const [name, ingress] of Object.entries(options.managedCaddy ?? {})) {
          await reconcileManagedCaddy(host, runtime, name, ingress);
        }
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
                  resolveTarget: (target, mode) => runtime.resolveTarget(workspace, target, mode)
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
      };

      const discovery = {
        ingresses: Object.entries(options.ingresses).map(([name, ingress]) => ({
          name,
          description: ingress.description,
          scheme: ingress.scheme
        })),
        target: {
          containers: "zero, one, or two nested container/service names",
          maxDepth: 2
        }
      };
      host.registerControllerRoute({
        method: "GET",
        path: "/urls",
        summary: "List external URLs for this workspace",
        audiences: ["workspace", "agent"],
        discovery,
        initialize,
        handle: (context) => mutations.run(() => listUrls(context, ingresses))
      });
      host.registerControllerRoute({
        method: "POST",
        path: "/urls",
        summary: "Create an external URL using a host-configured ingress",
        audiences: ["workspace", "agent"],
        discovery,
        handle: (context) => mutations.run(() => createUrl(context, ingresses))
      });
      host.registerControllerRoute({
        method: "DELETE",
        path: "/urls",
        summary: "Revoke every external URL for this workspace",
        audiences: ["workspace", "agent"],
        handle: (context) => mutations.run(() => deleteWorkspaceUrls(context, ingresses))
      });
      host.registerControllerRoute({
        method: "DELETE",
        path: "/urls/:id",
        summary: "Revoke an external URL",
        audiences: ["workspace", "agent"],
        handle: (context) => mutations.run(() => deleteUrl(context, ingresses))
      });

      return async () => Promise.all([...ingresses.values()].map((ingress) => ingress.listener.close())).then(() => {});
    }
  };
}

export async function externalUrlsPluginFromConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<DimPlugin> {
  const config = await readExternalUrlConfig(env);
  const ingresses: Record<string, ExternalUrlIngressOptions> = {};
  const managedCaddy: Record<string, ManagedCaddyIngress> = {};
  const requiredDnsDrivers = new Set<string>();
  for (const [name, ingress] of Object.entries(config.ingresses)) {
    if (ingress.driver === "caddy") {
      const argument = parseCaddyIngressArgument(ingress.argument);
      const provider = config.dnsProviders[argument.dnsProvider];
      if (!provider) throw new Error(`ingress '${name}' references missing DNS provider '${argument.dnsProvider}'`);
      requiredDnsDrivers.add(provider.driver);
      if (argument.listenPort === "auto") {
        throw new Error(`ingress '${name}' has unresolved Caddy listenPort; re-add it with the DIM CLI`);
      }
      const routerPort = await availableTcpPort("127.0.0.1", new Set([argument.listenPort]));
      ingresses[name] = {
        description: ingress.description,
        scheme: ingress.scheme,
        domain: argument.domain,
        ...(argument.listenPort === 443 ? {} : { port: argument.listenPort }),
        listenHost: "127.0.0.1",
        listenPort: routerPort,
        ...(argument.upstreamMode === undefined ? {} : { upstreamMode: argument.upstreamMode }),
        ...(argument.routePolicy === undefined ? {} : { routePolicy: argument.routePolicy }),
        ...(ingress.approvalRequired === undefined ? {} : { approvalRequired: ingress.approvalRequired }),
        approvalExposure: {
          listenHost: argument.listenHost,
          listenPort: argument.listenPort
        }
      };
      managedCaddy[name] = {
        argument: { ...argument, listenPort: argument.listenPort },
        provider,
        routerPort
      };
    } else if (ingress.driver === "http") {
      const argument = parseHttpIngressArgument(ingress.driver, ingress.argument);
      if (argument.listenPort === "auto") {
        throw new Error(`ingress '${name}' has unresolved listenPort 'auto'; re-add it with the DIM CLI`);
      }
      ingresses[name] = {
        description: ingress.description,
        scheme: ingress.scheme,
        domain: argument.domain,
        ...(argument.publicPort === undefined ? {} : { port: argument.publicPort }),
        listenHost: argument.listenHost,
        listenPort: argument.listenPort,
        ...(argument.upstreamMode === undefined ? {} : { upstreamMode: argument.upstreamMode }),
        ...(argument.routePolicy === undefined ? {} : { routePolicy: argument.routePolicy }),
        ...(ingress.approvalRequired === undefined ? {} : { approvalRequired: ingress.approvalRequired })
      };
    } else {
      const runtime = await tailscaleIngressDriver.runtime(ingress.argument);
      ingresses[name] = {
        description: ingress.description,
        scheme: runtime.scheme,
        domain: runtime.publicHost,
        listenHost: runtime.listenHost,
        listenPort: runtime.listenPort,
        upstreamMode: runtime.upstreamMode,
        ...(ingress.approvalRequired === undefined ? {} : { approvalRequired: ingress.approvalRequired })
      };
    }
  }
  return createExternalUrlsPlugin({
    ingresses,
    requiredDnsDrivers: [...requiredDnsDrivers],
    managedCaddy
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
        .find(([, ingress]) => ingress.driver === "caddy"
          && parseCaddyIngressArgument(ingress.argument).dnsProvider === name);
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
      let argument = await configureIngressArguments(host, driver, scheme, strings("arguments"));
      if (input.approvalRequired !== undefined && typeof input.approvalRequired !== "boolean") {
        throw new UserError("approvalRequired must be a boolean");
      }
      if (driver === "caddy") {
        const parsed = parseCaddyIngressArgument(argument);
        const dnsProvider = parsed.dnsProvider;
        const storedProvider = config.dnsProviders[dnsProvider];
        if (!storedProvider) {
          throw new UserError(
            `DNS provider '${dnsProvider}' is not configured; `
            + "run 'dim external-url dns-provider add --help' first"
          );
        }
        const providerDriver = dnsDriver(host, storedProvider.driver);
        parsed.dnsArgument = normalizeDnsRecordArgument(providerDriver, parsed.dnsArgument);
        argument = JSON.stringify(parsed);
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
      if (input.cleanupDns === true) {
        if (ingress.driver !== "caddy") throw new UserError(`ingress '${name}' does not have provider-managed DNS`);
        const argument = parseCaddyIngressArgument(ingress.argument);
        const storedProvider = config.dnsProviders[argument.dnsProvider];
        if (!storedProvider) throw new UserError(`DNS provider '${argument.dnsProvider}' is not configured`);
        await dnsDriver(host, storedProvider.driver).remove(dnsOperation(storedProvider, argument));
      }
      if (ingress.driver === "caddy") {
        await stopManagedCaddy(context, name);
      }
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
      if (ingress.driver === "caddy") {
        const argument = parseCaddyIngressArgument(ingress.argument);
        const storedProvider = config.dnsProviders[argument.dnsProvider];
        if (!storedProvider) throw new UserError(`DNS provider '${argument.dnsProvider}' is not configured`);
        await dnsDriver(host, storedProvider.driver).verify(dnsOperation(storedProvider, argument));
        await verifyCaddyIngress(argument);
      } else if (ingress.driver !== "http") {
        await ingressDriver(host, ingress.driver).verify(ingress.argument);
      }
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

async function reconcileManagedCaddy(
  host: DimPluginHost,
  runtime: ControllerRuntimeContext,
  name: string,
  ingress: ManagedCaddyIngress
): Promise<void> {
  const providerDriver = dnsDriver(host, ingress.provider.driver);
  await providerDriver.ensure(dnsOperation(ingress.provider, ingress.argument));
  const deployment = renderCaddyDeployment(
    name,
    ingress.argument,
    ingress.routerPort,
    providerDriver.caddyDns01(ingress.provider.argument)
  );
  const output = managedCaddyDirectory(runtime.stateRoot, name);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(output, "Dockerfile"), deployment.dockerfile),
    writeFile(path.join(output, "Caddyfile"), deployment.caddyfile),
    writeFile(path.join(output, "compose.yml"), deployment.compose),
    writeFile(path.join(output, ".env"), deployment.environment, { mode: 0o600 })
  ]);
  const result = await runtime.runner.run("docker", [
    "compose",
    "--project-directory",
    output,
    "--file",
    path.join(output, "compose.yml"),
    "up",
    "--detach",
    "--build"
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `could not start managed Caddy ingress '${name}': ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  host.logger.info("DIM managed Caddy ingress ready", {
    ingress: name,
    host: ingress.argument.listenHost,
    port: ingress.argument.listenPort
  });
}

async function stopManagedCaddy(context: AdminRouteContext, name: string): Promise<void> {
  await stopManagedCaddyAt(context.runner, context.lifecycle.stateRoot, name);
}

async function removeStaleManagedCaddy(
  runtime: ControllerRuntimeContext,
  configuredNames: ReadonlySet<string>
): Promise<void> {
  const root = path.join(runtime.stateRoot, "plugins", "external-urls", "caddy");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && !configuredNames.has(name)) {
      await stopManagedCaddyAt(runtime.runner, runtime.stateRoot, name);
    }
  }
}

async function stopManagedCaddyAt(
  runner: ControllerRuntimeContext["runner"],
  stateRoot: string,
  name: string
): Promise<void> {
  const output = managedCaddyDirectory(stateRoot, name);
  const composeFile = path.join(output, "compose.yml");
  try {
    await readFile(composeFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const result = await runner.run("docker", [
    "compose",
    "--project-directory",
    output,
    "--file",
    composeFile,
    "down",
    "--remove-orphans"
  ]);
  if (result.exitCode !== 0) {
    throw new UserError(
      `could not stop managed Caddy ingress '${name}': ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  await rm(output, { recursive: true, force: true });
}

function managedCaddyDirectory(stateRoot: string, name: string): string {
  return path.join(stateRoot, "plugins", "external-urls", "caddy", name);
}

function normalizeDnsProviderArgument(host: DimPluginHost, driver: string, argument: string): string {
  try {
    return dnsDriver(host, driver).normalizeProviderArgument(argument);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

function normalizeDnsRecordArgument(driver: ExternalUrlDnsProviderDriver, argument: string): string {
  try {
    return driver.normalizeRecordArgument(argument);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

function dnsDriver(host: DimPluginHost, name: string): ExternalUrlDnsProviderDriver {
  const driver = host.extension<ExternalUrlDnsProviderDriver>(EXTERNAL_URL_DNS_PROVIDER_EXTENSION, name);
  if (!driver) {
    throw new UserError(
      `external URL DNS provider driver '${name}' is not installed; install and enable its DIM plugin first`
    );
  }
  for (const method of [
    "normalizeProviderArgument",
    "normalizeRecordArgument",
    "ensure",
    "verify",
    "remove",
    "caddyDns01"
  ] as const) {
    if (typeof driver[method] !== "function") {
      throw new UserError(`external URL DNS provider driver '${name}' has an invalid '${method}' implementation`);
    }
  }
  return driver;
}

function dnsOperation(provider: ExternalUrlDnsProviderConfig, ingress: ReturnType<typeof parseCaddyIngressArgument>) {
  return {
    providerArgument: provider.argument,
    recordArgument: ingress.dnsArgument,
    domain: ingress.domain,
    env: process.env
  };
}

async function configureIngressArguments(
  host: DimPluginHost,
  driver: string,
  scheme: "http" | "https" | "tcp",
  arguments_: readonly string[]
): Promise<string> {
  if (driver !== "http" && driver !== "caddy") {
    return ingressDriver(host, driver).configure(scheme, arguments_);
  }
  const argument = JSON.stringify(parseIngressCliArguments(driver, arguments_));
  if (driver === "caddy") {
    if (scheme !== "https") {
      throw new UserError(
        "Caddy ingress requires '--scheme https'; use driver 'http' for '--scheme http'. "
        + `See ${CADDY_INGRESS_DOCUMENTATION_URL}`
      );
    }
    let parsed: ReturnType<typeof parseCaddyIngressArgument>;
    try {
      parsed = parseCaddyIngressArgument(argument);
    } catch (error) {
      throw new UserError(error instanceof Error ? error.message : String(error));
    }
    const listenPort = parsed.listenPort === "auto"
      ? await availableTcpPort(parsed.listenHost)
      : parsed.listenPort;
    return JSON.stringify({
      ...parsed,
      listenPort
    });
  }
  const parsed = parseHttpIngressArgument(driver, argument);
  return JSON.stringify({
    ...parsed,
    listenPort: parsed.listenPort === "auto" ? await availableTcpPort(parsed.listenHost) : parsed.listenPort
  });
}

function ingressDriver(host: DimPluginHost, name: string): ExternalUrlIngressDriver {
  const driver = host.extension<ExternalUrlIngressDriver>(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, name);
  if (!driver || typeof driver.configure !== "function"
    || typeof driver.runtime !== "function" || typeof driver.verify !== "function") {
    throw new UserError(
      `external URL ingress driver '${name}' is not installed; install and enable its DIM plugin first`
    );
  }
  return driver;
}

function parseIngressCliArguments(driver: string, arguments_: readonly string[]): Record<string, unknown> {
  const allowed = driver === "caddy"
    ? new Set(["domain", "listen-host", "listen-port", "upstream-mode", "dns-provider", "dns-argument", "acme-email"])
    : driver === "http"
      ? new Set(["domain", "listen-host", "listen-port", "public-port", "upstream-mode"])
      : undefined;
  if (!allowed) {
    throw new UserError(`unsupported external URL ingress driver '${driver}'; supported drivers: http, caddy`);
  }
  const result: Record<string, unknown> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (!option.startsWith("--") || !allowed.has(option.slice(2))) {
      throw new UserError(`unknown ${driver} ingress argument '${option}'`);
    }
    const value = arguments_[++index];
    if (value === undefined) throw new UserError(`${option} requires a value`);
    const key = option.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[key] = option === "--listen-port" && value === "auto"
      ? value
      : option === "--listen-port" || option === "--public-port"
        ? cliInteger(value, option)
        : value;
  }
  return result;
}

function cliInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UserError(`${option} requires an integer`);
  return parsed;
}

async function availableTcpPort(host: string, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  for (;;) {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => resolve());
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!address || typeof address === "string") throw new UserError(`could not allocate a TCP port on ${host}`);
    if (!excluded.has(address.port)) return address.port;
  }
}

function parseHttpIngressArgument(driver: string, argument: string): {
  domain: string;
  listenHost: string;
  listenPort: number | "auto";
  publicPort?: number;
  upstreamMode?: "container-ip" | "container-dns";
  routePolicy?: ExternalUrlRoutePolicyConfig;
} {
  if (driver !== "http") {
    throw new UserError(
      `unsupported external URL ingress driver '${driver}'; supported drivers: http, caddy`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw httpIngressArgumentError("must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpIngressArgumentError("must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length === 0) {
    throw httpIngressArgumentError("requires string field 'domain'");
  }
  if (typeof input.listenHost !== "string" || input.listenHost.length === 0) {
    throw httpIngressArgumentError("requires string field 'listenHost'");
  }
  if (input.listenPort !== "auto"
    && (!Number.isInteger(input.listenPort) || (input.listenPort as number) < 1 || (input.listenPort as number) > 65_535)) {
    throw httpIngressArgumentError("field 'listenPort' must be 'auto' or a port");
  }
  if (input.publicPort !== undefined
    && (!Number.isInteger(input.publicPort) || (input.publicPort as number) < 1 || (input.publicPort as number) > 65_535)) {
    throw httpIngressArgumentError("field 'publicPort' must be a port");
  }
  if (input.upstreamMode !== undefined && input.upstreamMode !== "container-ip" && input.upstreamMode !== "container-dns") {
    throw httpIngressArgumentError("field 'upstreamMode' must be container-ip or container-dns");
  }
  return {
    ...input,
    ...(input.routePolicy === undefined
      ? {}
      : { routePolicy: parseRoutePolicy(input.routePolicy, httpIngressArgumentError) })
  } as unknown as ReturnType<typeof parseHttpIngressArgument>;
}

const INGRESS_DOCUMENTATION_URL =
  "https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md#named-ingresses";

function httpIngressArgumentError(detail: string): UserError {
  return new UserError(`http ingress arguments ${detail}. See ${INGRESS_DOCUMENTATION_URL}`);
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
  const upstream = await context.resolveTarget(current.target, ingress.listener.upstreamMode);
  const reconciled = await ingress.listener.provision(
    context.workspace,
    storedRequest(current),
    upstream,
    current.route.ingressId ?? current.id,
    current.approval,
    current.subdomain === undefined ? undefined : current.id
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
  const upstream = await context.resolveTarget(request.target, ingress.listener.upstreamMode);
  const id = randomUUID();
  const approval: ExternalUrlApproval = ingress.options.approvalRequired === true ? "pending" : "not-required";
  const claim = approval === "not-required" ? routeClaim(context.workspace, request) : id;
  const provisioned = await ingress.listener.provision(
    context.workspace,
    request,
    upstream,
    claim,
    approval,
    request.subdomain === undefined ? undefined : id
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
    workspaceName: context.workspace.name,
    projectId: context.workspace.projectId,
    projectName: context.workspace.projectName,
    stateRoot: context.stateRoot
  }, ingresses);
  return { status: 204 };
}

async function removeWorkspaceRoutes(
  context: WorkspaceDiscardContext,
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
  if (!Array.isArray(containers) || containers.length > 2 || !containers.every((name) => typeof name === "string")) {
    throw new UserError("target.containers must contain zero, one, or two names");
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
  if (options.requiredDnsDrivers !== undefined
    && (!Array.isArray(options.requiredDnsDrivers)
      || !options.requiredDnsDrivers.every((name) => /^[a-z0-9][a-z0-9.-]*$/.test(name)))) {
    throw new Error("external URL requiredDnsDrivers must contain valid extension names");
  }
  const entries = Object.entries(options.ingresses);
  const domains = new Map<string, {
    name: string;
    upstreamMode: "container-dns" | "container-ip";
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
    if (ingress.upstreamMode !== undefined) upstreamMode(ingress.upstreamMode);
    if (ingress.routePolicy !== undefined) parseRoutePolicy(ingress.routePolicy);
    if (ingress.scheme === "tcp" && (ingress.routePolicy !== undefined || ingress.port !== undefined)) {
      throw new Error(`external URL TCP ingress '${name}' cannot configure HTTP route policy or a separate public port`);
    }
    if (ingress.scheme === "tcp") continue;
    const domain = normalizeDomain(ingress.domain);
    const routing = {
      name,
      upstreamMode: ingress.upstreamMode ?? "container-ip",
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
    if (existing && (existing.upstreamMode !== routing.upstreamMode
      || existing.routePolicy !== routing.routePolicy
      || existing.approvalRequired !== routing.approvalRequired)) {
      throw new Error(
        `external URL ingresses '${existing.name}' and '${name}' share domain '${domain}' `
        + "and must use the same upstream mode, route policy, and approval requirement"
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

function upstreamMode(value: string): "container-dns" | "container-ip" {
  if (value !== "container-dns" && value !== "container-ip") {
    throw new Error("proxy upstream mode must be container-dns or container-ip");
  }
  return value;
}

const plugin: DimPlugin = {
  name: "@slop-lab/dim-plugin-external-urls",
  apiVersion: DIM_PLUGIN_API_VERSION,
  async register(host) {
    return (await externalUrlsPluginFromConfig()).register(host);
  }
};

export default plugin;
