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
  type ControllerRouteContext,
  type ControllerRuntimeContext,
  type ControllerWorkspace,
  type DimPlugin,
  type DimPluginLogger,
  type ResolvedWorkspaceTarget,
  type WorkspaceTarget
} from "@slop-lab/dim-core";
import {
  readExternalUrlConfig,
  writeExternalUrlConfig,
  type ExternalUrlIngressConfig
} from "@slop-lab/dim-contracts-external-url";
import {
  parseCaddyIngressArgument,
  renderCaddyDeployment,
  verifyCaddyIngress
} from "@slop-lab/dim-ingress-caddy";
import {
  ensureCloudflareWildcard,
  removeCloudflareWildcard,
  verifyCloudflareWildcard
} from "@slop-lab/dim-provider-dns-cloudflare";

export interface ExternalUrlIngressOptions {
  description: string;
  scheme: "http" | "https";
  domain: string;
  port?: number;
  listenHost: string;
  listenPort: number;
  upstreamMode?: "container-dns" | "container-ip";
}

export interface ExternalUrlsPluginOptions {
  ingresses: Readonly<Record<string, ExternalUrlIngressOptions>>;
}

interface NormalizedRequest {
  ingress: string;
  service: string;
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
  service: string;
  target: WorkspaceTarget;
  path?: string;
  route: ExternalRoute;
  url: string;
  createdAt: string;
}

interface IngressRouter {
  name: string;
  upstreamMode: "container-dns" | "container-ip";
  provision(workspace: ControllerWorkspace, request: NormalizedRequest, upstream: ResolvedWorkspaceTarget): Promise<ExternalRoute>;
  revoke(route: ExternalRoute): Promise<void>;
  close(): Promise<void>;
}

interface ConfiguredIngress {
  options: ExternalUrlIngressOptions;
  router: IngressRouter;
}

interface RouterOptions {
  name: string;
  listenHost: string;
  listenPort: number;
  upstreamMode: "container-dns" | "container-ip";
  scheme: "http" | "https";
  domain: string;
  port?: number;
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
        summary: "Manage External URL providers and ingresses",
        async handle(context) {
          return { body: await externalUrlAdmin(context.params.action ?? "", await context.readJson()) };
        }
      });
      if (Object.keys(options.ingresses).length === 0) {
        host.logger.warn(
          "External URLs plugin has no configured ingress; run 'dim external-url ingress add --help' to add one"
        );
      }
      const ingresses = new Map<string, ConfiguredIngress>();
      for (const [name, ingress] of Object.entries(options.ingresses)) {
        ingresses.set(name, {
          options: ingress,
          router: new WorkspaceIngressRouter({
            name,
            listenHost: ingress.listenHost,
            listenPort: ingress.listenPort,
            upstreamMode: ingress.upstreamMode ?? "container-ip",
            scheme: ingress.scheme,
            domain: ingress.domain,
            ...(ingress.port === undefined ? {} : { port: ingress.port })
          }, host.logger)
        });
      }

      const initialize = async (runtime: ControllerRuntimeContext): Promise<void> => {
        const store = new ExternalUrlStore(runtime.stateRoot);
        for (const workspace of await runtime.listWorkspaces()) {
          for (const entry of deduplicateRoutes(await store.list(workspace.id))) {
            const ingress = required(ingresses, entry.ingress);
            const upstream = await runtime.resolveTarget(workspace, entry.target, ingress.router.upstreamMode);
            const reconciled = await ingress.router.provision(workspace, storedRequest(entry), upstream);
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
        discovery,
        initialize,
        handle: (context) => listUrls(context)
      });
      host.registerControllerRoute({
        method: "POST",
        path: "/urls",
        summary: "Create an external URL using a host-configured ingress",
        discovery,
        handle: (context) => createUrl(context, ingresses)
      });
      host.registerControllerRoute({
        method: "DELETE",
        path: "/urls",
        summary: "Revoke every external URL for this workspace",
        handle: (context) => deleteWorkspaceUrls(context, ingresses)
      });
      host.registerControllerRoute({
        method: "DELETE",
        path: "/urls/:id",
        summary: "Revoke an external URL",
        handle: (context) => deleteUrl(context, ingresses)
      });

      return async () => Promise.all([...ingresses.values()].map((ingress) => ingress.router.close())).then(() => {});
    }
  };
}

export async function externalUrlsPluginFromConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<DimPlugin> {
  const config = await readExternalUrlConfig(env);
  const ingresses: Record<string, ExternalUrlIngressOptions> = {};
  for (const [name, ingress] of Object.entries(config.ingresses)) {
    const argument = ingress.driver === "caddy"
      ? parseCaddyIngressArgument(ingress.argument)
      : parseBuiltinHttpArgument(ingress.driver, ingress.argument);
    if (argument.listenPort === "auto") {
      throw new Error(`ingress '${name}' has unresolved listenPort 'auto'; re-add it with the DIM CLI`);
    }
    ingresses[name] = {
      description: ingress.description,
      scheme: ingress.scheme,
      domain: argument.domain,
      ...("publicPort" in argument && argument.publicPort !== undefined ? { port: argument.publicPort } : {}),
      listenHost: argument.listenHost,
      listenPort: argument.listenPort,
      ...(argument.upstreamMode === undefined ? {} : { upstreamMode: argument.upstreamMode })
    };
  }
  return createExternalUrlsPlugin({ ingresses });
}

async function externalUrlAdmin(action: string, value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  const text = (name: string) => {
    const result = input[name];
    if (typeof result !== "string") throw new UserError(`${name} must be a string`);
    return result;
  };
  const config = await readExternalUrlConfig();
  switch (action) {
    case "provider-add": {
      const driver = text("driver");
      if (driver !== "cloudflare") throw new UserError("provider driver must be cloudflare");
      const recordType = text("recordType");
      if (recordType !== "A" && recordType !== "AAAA" && recordType !== "CNAME") {
        throw new UserError("recordType must be A, AAAA, or CNAME");
      }
      config.providers[text("name")] = {
        driver: "cloudflare",
        zone: text("zone"),
        recordType,
        target: text("target"),
        proxied: input.proxied === true,
        credentialEnv: text("credentialEnv")
      };
      await writeExternalUrlConfig(config);
      return {};
    }
    case "provider-list":
      return Object.entries(config.providers).map(([name, provider]) => ({ name, ...provider }));
    case "provider-remove": {
      const name = text("name");
      if (!config.providers[name]) throw new UserError(`external URL provider '${name}' is not configured`);
      const dependent = Object.entries(config.ingresses)
        .find(([, ingress]) => ingress.driver === "caddy"
          && parseCaddyIngressArgument(ingress.argument).provider === name);
      if (dependent) throw new UserError(`external URL provider '${name}' is used by ingress '${dependent[0]}'`);
      delete config.providers[name];
      await writeExternalUrlConfig(config);
      return {};
    }
    case "ingress-add": {
      const driver = text("driver");
      const scheme = text("scheme");
      if (scheme !== "http" && scheme !== "https") throw new UserError("scheme must be http or https");
      const ingress: ExternalUrlIngressConfig = {
        driver,
        description: text("description"),
        scheme,
        argument: await configureIngressArgument(driver, scheme, text("argument"))
      };
      config.ingresses[text("name")] = ingress;
      await writeExternalUrlConfig(config);
      return {};
    }
    case "ingress-list":
      return Object.entries(config.ingresses).map(([name, ingress]) => ({ name, ...ingress }));
    case "ingress-credential-env": {
      const ingress = config.ingresses[text("name")];
      if (!ingress || ingress.driver !== "caddy") return { credentialEnv: null };
      const provider = config.providers[parseCaddyIngressArgument(ingress.argument).provider];
      if (!provider) throw new UserError("ingress references an unconfigured provider");
      return { credentialEnv: provider.credentialEnv };
    }
    case "ingress-remove": {
      const name = text("name");
      const ingress = config.ingresses[name];
      if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
      if (input.cleanupDns === true) {
        if (ingress.driver !== "caddy") throw new UserError(`ingress '${name}' does not have provider-managed DNS`);
        const argument = parseCaddyIngressArgument(ingress.argument);
        const provider = config.providers[argument.provider];
        if (!provider) throw new UserError(`provider '${argument.provider}' is not configured`);
        const env = requestEnvironment(input, provider.credentialEnv);
        await removeCloudflareWildcard(
          provider,
          await verifyCloudflareWildcard(provider, argument.domain, env),
          env
        );
      }
      delete config.ingresses[name];
      await writeExternalUrlConfig(config);
      return {};
    }
    case "ingress-setup": {
      const name = text("name");
      const ingress = config.ingresses[name];
      if (!ingress || ingress.driver !== "caddy") throw new UserError(`ingress '${name}' does not require Caddy setup`);
      const argument = parseCaddyIngressArgument(ingress.argument);
      if (argument.listenPort === "auto") throw new UserError(`ingress '${name}' has unresolved auto port`);
      const provider = config.providers[argument.provider];
      if (!provider) throw new UserError(`provider '${argument.provider}' is not configured`);
      await ensureCloudflareWildcard(provider, argument.domain, requestEnvironment(input, provider.credentialEnv));
      const deployment = renderCaddyDeployment(name, { ...argument, listenPort: argument.listenPort }, provider);
      const output = path.resolve(text("output"), name);
      await mkdir(output, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(path.join(output, "Dockerfile"), deployment.dockerfile),
        writeFile(path.join(output, "Caddyfile"), deployment.caddyfile),
        writeFile(path.join(output, "compose.yml"), deployment.compose),
        writeFile(path.join(output, ".env.example"), deployment.environmentExample, { mode: 0o600 })
      ]);
      return { output };
    }
    case "ingress-verify": {
      const name = text("name");
      const ingress = config.ingresses[name];
      if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
      if (ingress.driver === "caddy") {
        const argument = parseCaddyIngressArgument(ingress.argument);
        const provider = config.providers[argument.provider];
        if (!provider) throw new UserError(`provider '${argument.provider}' is not configured`);
        await verifyCloudflareWildcard(provider, argument.domain, requestEnvironment(input, provider.credentialEnv));
        await verifyCaddyIngress(argument);
      }
      return {};
    }
    default: throw new UserError(`unknown External URL admin action '${action}'`);
  }
}

function requestEnvironment(input: Record<string, unknown>, credentialEnv: string): NodeJS.ProcessEnv {
  if (typeof input.credential !== "string" || input.credential.length === 0) {
    throw new UserError(`credential ${credentialEnv} is required`);
  }
  return {
    ...process.env,
    [credentialEnv]: input.credential,
    ...(typeof input.cloudflareApiBase === "string"
      ? { DIM_CLOUDFLARE_API_BASE: input.cloudflareApiBase }
      : {})
  };
}

async function configureIngressArgument(
  driver: string,
  scheme: "http" | "https",
  argument: string
): Promise<string> {
  if (driver === "caddy") {
    if (scheme !== "https") throw new UserError("Caddy ingress requires scheme https");
    const parsed = parseCaddyIngressArgument(argument);
    return JSON.stringify({
      ...parsed,
      listenPort: parsed.listenPort === "auto" ? await availableTcpPort(parsed.listenHost) : parsed.listenPort
    });
  }
  const parsed = parseBuiltinHttpArgument(driver, argument);
  return JSON.stringify({
    ...parsed,
    listenPort: parsed.listenPort === "auto" ? await availableTcpPort(parsed.listenHost) : parsed.listenPort
  });
}

async function availableTcpPort(host: string): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new UserError(`could not allocate a TCP port on ${host}`);
  return address.port;
}

function parseBuiltinHttpArgument(driver: string, argument: string): {
  domain: string;
  listenHost: string;
  listenPort: number | "auto";
  publicPort?: number;
  upstreamMode?: "container-ip" | "container-dns";
} {
  if (driver !== "builtin-http") throw new Error(`unsupported external URL ingress driver '${driver}'`);
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw new Error("builtin-http ingress argument must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("builtin-http ingress argument must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length === 0) throw new Error("builtin-http argument requires domain");
  if (typeof input.listenHost !== "string" || input.listenHost.length === 0) {
    throw new Error("builtin-http argument requires listenHost");
  }
  if (input.listenPort !== "auto"
    && (!Number.isInteger(input.listenPort) || (input.listenPort as number) < 1 || (input.listenPort as number) > 65_535)) {
    throw new Error("builtin-http argument listenPort must be 'auto' or a port");
  }
  if (input.publicPort !== undefined
    && (!Number.isInteger(input.publicPort) || (input.publicPort as number) < 1 || (input.publicPort as number) > 65_535)) {
    throw new Error("builtin-http argument publicPort must be a port");
  }
  if (input.upstreamMode !== undefined && input.upstreamMode !== "container-ip" && input.upstreamMode !== "container-dns") {
    throw new Error("builtin-http argument upstreamMode must be container-ip or container-dns");
  }
  return input as unknown as ReturnType<typeof parseBuiltinHttpArgument>;
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
  if (input && typeof input === "object" && input.service === undefined) {
    const existing = await new ExternalUrlStore(context.stateRoot).list(context.workspace.id);
    const used = new Set(existing.map((entry) => entry.service));
    let index = 0;
    while (used.has(String(index))) index += 1;
    input.service = String(index);
  }
  const request = validateRequest(input);
  const ingress = required(ingresses, request.ingress);
  const upstream = await context.resolveTarget(request.target, ingress.router.upstreamMode);
  const route = await ingress.router.provision(context.workspace, request, upstream);
  try {
    const url = route.url;
    if (!url) throw new Error(`ingress '${request.ingress}' did not return a public URL`);
    const entry: StoredUrl = {
      id: randomUUID(),
      workspace: context.workspace.name,
      workspaceId: context.workspace.id,
      ingress: request.ingress,
      service: request.service,
      target: request.target,
      ...(request.path === undefined ? {} : { path: request.path }),
      route,
      url,
      createdAt: new Date().toISOString()
    };
    await new ExternalUrlStore(context.stateRoot).put(entry);
    return { status: 201, body: { urls: [publicEntry(entry)] } };
  } catch (error) {
    await ingress.router.revoke(route).catch(() => {});
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
    await ingress.router.revoke(entry.route);
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
    if (ingress) await ingress.router.revoke(entry.route);
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

class WorkspaceIngressRouter implements IngressRouter {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #routes = new Map<string, ResolvedWorkspaceTarget>();
  readonly #server: http.Server;
  readonly #ready: Promise<void>;
  readonly #scheme: "http" | "https";
  readonly #domain: string;
  readonly #port: number | undefined;

  constructor(
    options: RouterOptions,
    logger: DimPluginLogger
  ) {
    this.name = options.name;
    this.upstreamMode = options.upstreamMode;
    this.#scheme = options.scheme;
    this.#domain = options.domain;
    this.#port = options.port;
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
    const authority = routeLabel(request.service, workspace.name);
    const existing = this.#routes.get(authority);
    if (existing && JSON.stringify(existing) !== JSON.stringify(upstream)) {
      throw new UserError(`external route '${authority}' already targets another service`);
    }
    this.#routes.set(authority, upstream);
    const publicAuthority = `${authority}.${normalizeDomain(this.#domain)}${
      this.#port === undefined ? "" : `:${this.#port}`
    }`;
    const url = validateExternalUrl(`${this.#scheme}://${publicAuthority}${request.path ?? "/"}`);
    return { id: randomUUID(), ingress: this.name, authority, ingressId: authority, url };
  }

  async revoke(route: ExternalRoute): Promise<void> {
    this.#routes.delete(route.ingressId ?? route.authority);
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
    return this.#routes.get(hostname.split(".")[0] ?? "");
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
        ...request.headers,
        host: `${target.host}:${target.port}`,
        "x-forwarded-host": request.headers.host ?? "",
        "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http"
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
  if (typeof input.service !== "string" || !/^(?!.*--)[a-z0-9][a-z0-9-]{0,62}$/.test(input.service)) {
    throw new UserError("name must be a DNS label without '--'");
  }
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
    service: input.service,
    target: {
      containers: containers as string[],
      port: target.port as number,
      protocol: (target.protocol ?? "http") as "http" | "https"
    },
    ...(input.path === undefined ? {} : { path: input.path as string })
  };
}

function validateOptions(options: ExternalUrlsPluginOptions): void {
  const entries = Object.entries(options.ingresses);
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
    service: entry.service,
    target: entry.target,
    ...(entry.path === undefined ? {} : { path: entry.path })
  };
}

function storedUrl(value: unknown): StoredUrl {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid stored external URL");
  }
  const candidate = value as StoredUrl;
  if (typeof candidate.ingress !== "string" || typeof candidate.route?.ingress !== "string") {
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

function routeLabel(service: string, workspace: string): string {
  const value = `${workspace}--${service}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (value.length <= 63) return value;
  return `${value.slice(0, 54)}-${stableHash(value).toString(16).padStart(8, "0")}`;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
