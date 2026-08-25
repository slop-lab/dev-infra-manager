import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import {
  DIM_PLUGIN_API_VERSION,
  UserError,
  type AdminRouteContext,
  type ControllerRouteContext,
  type ControllerRuntimeContext,
  type ControllerWorkspace,
  type DimPlugin,
  type DimPluginHost,
  type DimPluginLogger,
  type ResolvedWorkspaceTarget,
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
import {
  applyRoutePolicy,
  parseRoutePolicy,
  workspaceSubdomainPrefix,
  type ExternalUrlRoutePolicyConfig
} from "./routePolicy.js";

export interface ExternalUrlIngressOptions {
  description: string;
  scheme: "http" | "https";
  domain: string;
  port?: number;
  listenHost: string;
  listenPort: number;
  upstreamMode?: "container-dns" | "container-ip";
  routePolicy?: ExternalUrlRoutePolicyConfig;
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

interface NormalizedRequest {
  ingress: string;
  subdomain: string;
  target: WorkspaceTarget;
  path?: string;
}

interface ExternalRoute {
  id: string;
  ingress: string;
  authority: string;
  ingressId?: string;
  url?: string;
}

interface StoredUrl {
  id: string;
  workspace: string;
  workspaceId: string;
  ingress: string;
  subdomain: string;
  target: WorkspaceTarget;
  path?: string;
  route: ExternalRoute;
  url: string;
  createdAt: string;
}

interface IngressListener {
  name: string;
  upstreamMode: "container-dns" | "container-ip";
  provision(workspace: ControllerWorkspace, request: NormalizedRequest, upstream: ResolvedWorkspaceTarget): Promise<ExternalRoute>;
  revoke(route: ExternalRoute): Promise<void>;
  close(): Promise<void>;
}

interface ConfiguredIngress {
  options: ExternalUrlIngressOptions;
  listener: IngressListener;
}

interface ListenerOptions {
  name: string;
  listenHost: string;
  listenPort: number;
  upstreamMode: "container-dns" | "container-ip";
  scheme: "http" | "https";
  domain: string;
  port?: number;
  routePolicy?: ExternalUrlRoutePolicyConfig;
}

export function createExternalUrlsPlugin(options: ExternalUrlsPluginOptions): DimPlugin {
  validateOptions(options);

  return {
    name: "@slop-lab/dim-plugin-external-urls",
    apiVersion: DIM_PLUGIN_API_VERSION,
    register(host) {
      host.registerAdminRoute({
        method: "POST",
        path: "/external-url/:action",
        summary: "Manage External URL DNS providers and ingresses",
        async handle(context) {
          return {
            body: await externalUrlAdmin(
              host,
              context,
              context.params.action ?? "",
              await context.readJson()
            )
          };
        }
      });
      const registry = new WorkspaceRouteRegistry();
      const mutations = new RouteMutationQueue();
      const ingresses = new Map<string, ConfiguredIngress>();
      for (const [name, ingress] of Object.entries(options.ingresses)) {
        ingresses.set(name, {
          options: ingress,
          listener: new WorkspaceIngressListener(registry, {
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

      const initialize = async (runtime: ControllerRuntimeContext): Promise<void> => {
        for (const driver of options.requiredDnsDrivers ?? []) dnsDriver(host, driver);
        await removeStaleManagedCaddy(runtime, new Set(Object.keys(options.managedCaddy ?? {})));
        for (const [name, ingress] of Object.entries(options.managedCaddy ?? {})) {
          await reconcileManagedCaddy(host, runtime, name, ingress);
        }
        const store = new ExternalUrlStore(runtime.stateRoot);
        for (const workspace of await runtime.listWorkspaces()) {
          for (const entry of deduplicateRoutes(await store.list(workspace.id))) {
            const ingress = required(ingresses, entry.ingress);
            const upstream = await runtime.resolveTarget(workspace, entry.target, ingress.listener.upstreamMode);
            const reconciled = await ingress.listener.provision(workspace, storedRequest(entry), upstream);
            if (reconciled.authority !== entry.route.authority) {
              throw new Error(`external route '${entry.route.id}' changed authority during reconciliation`);
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
        handle: (context) => listUrls(context)
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
        ...(argument.routePolicy === undefined ? {} : { routePolicy: argument.routePolicy })
      };
      managedCaddy[name] = {
        argument: { ...argument, listenPort: argument.listenPort },
        provider,
        routerPort
      };
    } else {
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
        ...(argument.routePolicy === undefined ? {} : { routePolicy: argument.routePolicy })
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
  action: string,
  value: unknown
): Promise<unknown> {
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
  const config = await readExternalUrlConfig();
  switch (action) {
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
      if (scheme !== "http" && scheme !== "https") throw new UserError("scheme must be http or https");
      let argument = await configureIngressArguments(driver, scheme, strings("arguments"));
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
        argument
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
      }
      return {};
    }
    default: throw new UserError(`unknown External URL admin action '${action}'`);
  }
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
  driver: string,
  scheme: "http" | "https",
  arguments_: readonly string[]
): Promise<string> {
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

async function listUrls(context: ControllerRouteContext) {
  return {
    body: {
      urls: publicEntries(await new ExternalUrlStore(context.stateRoot).list(context.workspace.id))
    }
  };
}

async function createUrl(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const input = await context.readJson() as Record<string, unknown>;
  if (input && typeof input === "object" && input.subdomain === undefined) {
    const existing = await new ExternalUrlStore(context.stateRoot).list(context.workspace.id);
    const used = new Set(existing.map((entry) => entry.subdomain));
    let index = 0;
    const prefix = workspaceSubdomainPrefix(context.workspace.name);
    while (used.has(`${prefix}${index}`)) index += 1;
    input.subdomain = `${prefix}${index}`;
  }
  const request = validateRequest(input);
  const ingress = required(ingresses, request.ingress);
  const upstream = await context.resolveTarget(request.target, ingress.listener.upstreamMode);
  const route = await ingress.listener.provision(context.workspace, request, upstream);
  try {
    const url = route.url;
    if (!url) throw new Error(`ingress '${request.ingress}' did not return a public URL`);
    const entry: StoredUrl = {
      id: randomUUID(),
      workspace: context.workspace.name,
      workspaceId: context.workspace.id,
      ingress: request.ingress,
      subdomain: request.subdomain,
      target: request.target,
      ...(request.path === undefined ? {} : { path: request.path }),
      route,
      url,
      createdAt: new Date().toISOString()
    };
    await new ExternalUrlStore(context.stateRoot).put(entry);
    return { status: 201, body: { urls: [publicEntry(entry)] } };
  } catch (error) {
    await ingress.listener.revoke(route).catch(() => {});
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
  await store.remove(entry);
  if (!entries.some((candidate) => candidate.id !== entry.id
    && candidate.route.ingress === entry.route.ingress
    && candidate.route.authority === entry.route.authority)) {
    await ingress.listener.revoke(entry.route);
  }
  return { status: 204 };
}

async function deleteWorkspaceUrls(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const store = new ExternalUrlStore(context.stateRoot);
  for (const entry of await store.list(context.workspace.id)) {
    const ingress = ingresses.get(entry.ingress);
    if (ingress) await ingress.listener.revoke(entry.route);
    await store.remove(entry);
  }
  return { status: 204 };
}

class ExternalUrlStore {
  constructor(readonly stateRoot: string) {}

  async list(workspaceId: string): Promise<StoredUrl[]> {
    const directory = this.directory(workspaceId);
    try {
      const names = await readdir(directory);
      return await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as unknown;
        return storedUrl(value);
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async put(entry: StoredUrl): Promise<void> {
    const target = this.entryPath(entry.workspaceId, entry.id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(entry: StoredUrl): Promise<void> {
    await rm(this.entryPath(entry.workspaceId, entry.id), { force: true });
  }

  private directory(workspaceId: string): string {
    return path.join(this.stateRoot, "plugins", "external-urls", Buffer.from(workspaceId).toString("base64url"));
  }

  private entryPath(workspaceId: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError("invalid external URL id");
    return path.join(this.directory(workspaceId), `${id}.json`);
  }
}

class WorkspaceRouteRegistry {
  readonly #routes = new Map<string, {
    upstream: ResolvedWorkspaceTarget;
    claims: Set<string>;
  }>();

  provision(authority: string, claim: string, upstream: ResolvedWorkspaceTarget): void {
    const existing = this.#routes.get(authority);
    if (existing && JSON.stringify(existing.upstream) !== JSON.stringify(upstream)) {
      throw new UserError(`external route '${authority}' already targets another service`);
    }
    if (existing) existing.claims.add(claim);
    else this.#routes.set(authority, { upstream, claims: new Set([claim]) });
  }

  revoke(authority: string, claim: string): void {
    const existing = this.#routes.get(authority);
    if (!existing) return;
    existing.claims.delete(claim);
    if (existing.claims.size === 0) this.#routes.delete(authority);
  }

  target(host: string): ResolvedWorkspaceTarget | undefined {
    return this.#routes.get(host.toLowerCase().replace(/\.$/, ""))?.upstream;
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

class WorkspaceIngressListener implements IngressListener {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #registry: WorkspaceRouteRegistry;
  readonly #server: http.Server;
  readonly #ready: Promise<void>;
  readonly #scheme: "http" | "https";
  readonly #domain: string;
  readonly #port: number | undefined;
  readonly #routePolicy: ExternalUrlRoutePolicyConfig | undefined;

  constructor(
    registry: WorkspaceRouteRegistry,
    options: ListenerOptions,
    logger: DimPluginLogger
  ) {
    this.#registry = registry;
    this.name = options.name;
    this.upstreamMode = options.upstreamMode;
    this.#scheme = options.scheme;
    this.#domain = options.domain;
    this.#port = options.port;
    this.#routePolicy = options.routePolicy;
    this.#server = http.createServer((request, response) => this.#proxy(request, response));
    this.#server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    this.#ready = new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(options.listenPort, options.listenHost, () => {
        this.#server.off("error", reject);
        logger.info("DIM external URL reverse proxy listening", {
          ingress: options.name,
          host: options.listenHost,
          port: options.listenPort,
          upstreamMode: options.upstreamMode
        });
        resolve();
      });
    });
  }

  async provision(workspace: ControllerWorkspace, request: NormalizedRequest, upstream: ResolvedWorkspaceTarget) {
    await this.#ready;
    const subdomain = await applyRoutePolicy(this.#routePolicy, {
      workspace: { id: workspace.id, name: workspace.name },
      ingress: this.name,
      requestedSubdomain: request.subdomain,
      domain: normalizeDomain(this.#domain)
    });
    validateSubdomain(subdomain);
    const authority = `${subdomain}.${normalizeDomain(this.#domain)}`;
    const claim = routeClaim(workspace, request);
    this.#registry.provision(authority, claim, upstream);
    const publicAuthority = `${authority}${
      this.#port === undefined ? "" : `:${this.#port}`
    }`;
    const url = validateExternalUrl(`${this.#scheme}://${publicAuthority}${request.path ?? "/"}`);
    return { id: randomUUID(), ingress: this.name, authority, ingressId: claim, url };
  }

  async revoke(route: ExternalRoute): Promise<void> {
    this.#registry.revoke(route.authority, route.ingressId ?? route.authority);
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => {});
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }

  #target(request: IncomingMessage): ResolvedWorkspaceTarget | undefined {
    const hostname = (request.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    return this.#registry.target(hostname);
  }

  #proxy(request: IncomingMessage, response: ServerResponse): void {
    const target = this.#target(request);
    if (!target) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"external route not found"}\n');
      return;
    }
    const transport = target.protocol === "https" ? https : http;
    const upstream = transport.request({
      hostname: target.host,
      port: target.port,
      method: request.method,
      path: request.url ?? "/",
      headers: {
        ...proxyHeaders(request.headers),
        host: `${target.host}:${target.port}`,
        "x-forwarded-host": request.headers.host ?? "",
        "x-forwarded-proto": this.#scheme,
        "x-forwarded-for": request.socket.remoteAddress ?? ""
      }
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  #upgrade(request: IncomingMessage, client: import("node:stream").Duplex, head: Buffer): void {
    const target = this.#target(request);
    if (!target) {
      client.destroy();
      return;
    }
    const connect = target.protocol === "https"
      ? () => tls.connect(target.port, target.host)
      : () => net.connect(target.port, target.host);
    const upstream = connect();
    upstream.once("connect", () => {
      const headers = Object.entries(request.headers)
        .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value ?? ""}`]);
      upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
  }
}

function validateRequest(value: unknown): NormalizedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.ingress !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.ingress)) {
    throw new UserError("ingress must be a configured ingress name");
  }
  if (typeof input.subdomain !== "string") {
    throw new UserError("subdomain must be a relative DNS name");
  }
  validateSubdomain(input.subdomain);
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
  if (target.protocol !== undefined && target.protocol !== "http" && target.protocol !== "https") {
    throw new UserError("target.protocol must be http or https");
  }
  if (input.path !== undefined && (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.includes(".."))) {
    throw new UserError("path must be an absolute URL path without '..'");
  }
  return {
    ingress: input.ingress,
    subdomain: input.subdomain,
    target: {
      containers: containers as string[],
      port: target.port as number,
      protocol: (target.protocol ?? "http") as "http" | "https"
    },
    ...(input.path === undefined ? {} : { path: input.path as string })
  };
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
  }>();
  for (const [name, ingress] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`invalid external URL ingress '${name}'`);
    if (typeof ingress.description !== "string" || ingress.description.trim().length === 0) {
      throw new Error(`external URL ingress '${name}' requires a description`);
    }
    if (ingress.scheme !== "http" && ingress.scheme !== "https") {
      throw new Error(`external URL ingress '${name}' scheme must be http or https`);
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
    const domain = normalizeDomain(ingress.domain);
    const routing = {
      name,
      upstreamMode: ingress.upstreamMode ?? "container-ip",
      routePolicy: JSON.stringify(ingress.routePolicy ?? { driver: "workspace-prefix" })
    };
    const existing = domains.get(domain);
    if (existing && (existing.upstreamMode !== routing.upstreamMode
      || existing.routePolicy !== routing.routePolicy)) {
      throw new Error(
        `external URL ingresses '${existing.name}' and '${name}' share domain '${domain}' `
        + "and must use the same upstream mode and route policy"
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

function publicEntries(entries: StoredUrl[]) {
  return entries.map(publicEntry);
}

function publicEntry({ route: _route, workspaceId: _workspaceId, ...entry }: StoredUrl) {
  return entry;
}

function deduplicateRoutes(entries: StoredUrl[]): StoredUrl[] {
  return [...new Map(entries.map((entry) => [entry.route.id, entry])).values()];
}

function storedRequest(entry: StoredUrl): NormalizedRequest {
  return {
    ingress: entry.ingress,
    subdomain: entry.subdomain,
    target: entry.target,
    ...(entry.path === undefined ? {} : { path: entry.path })
  };
}

function storedUrl(value: unknown): StoredUrl {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid stored external URL");
  }
  const candidate = value as StoredUrl;
  if (typeof candidate.ingress !== "string" || typeof candidate.subdomain !== "string"
    || typeof candidate.route?.ingress !== "string") {
    throw new Error(`invalid stored external URL '${candidate.id}'`);
  }
  return candidate;
}

function validateExternalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("provider returned a non-HTTP URL");
  if (url.username || url.password) throw new UserError("provider returned a URL containing credentials");
  return url.href;
}

function validateSubdomain(value: string): void {
  if (value.length === 0 || value.length > 253 || value.endsWith(".")
    || !value.split(".").every((label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new UserError("subdomain must be a lowercase relative DNS name");
  }
}

function proxyHeaders(headers: IncomingMessage["headers"]): IncomingMessage["headers"] {
  const result = { ...headers };
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]) {
    delete result[name];
  }
  return result;
}

function routeClaim(workspace: ControllerWorkspace, request: NormalizedRequest): string {
  return [
    workspace.id,
    request.ingress,
    request.subdomain,
    JSON.stringify(request.target)
  ].join("\u0000");
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
