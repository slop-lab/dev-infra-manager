import type { ExternalUrlIngressDriver, IngressDriverContext } from "./plugin-api.js";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "@slop-lab/dim-host-core";
import type { AdminRouteContext, ControllerRuntimeContext, DimPluginHost } from "@slop-lab/dim-host-core/controller";
import type { ExternalUrlDnsProviderConfig } from "@slop-lab/dim-contracts-external-url";
import { parseCaddyIngressArgument, renderCaddyDeployment, verifyCaddyIngress, CADDY_INGRESS_DOCUMENTATION_URL } from "./caddy.js";
import { dnsDriver, normalizeDnsRecordArgument } from "./dnsProvider.js";
import { availableTcpPort, parseIngressCliArguments } from "./ingressDriver.js";

interface ManagedCaddyIngress {
  argument: ReturnType<typeof parseCaddyIngressArgument> & { listenPort: number };
  provider: ExternalUrlDnsProviderConfig;
  routerPort: number;
}
function provider(context: IngressDriverContext, name: string): ExternalUrlDnsProviderConfig {
  const selected = context.config.dnsProviders[name];
  if (!selected) throw new UserError(`DNS provider '${name}' is not configured; run 'dim external-url dns-provider add --help' first`);
  return selected;
}
export const caddyIngressDriver: ExternalUrlIngressDriver = {
  async configure(scheme, args, context) {
    if (scheme !== "https") throw new UserError(`Caddy ingress requires '--scheme https'; use driver 'http' for '--scheme http'. See ${CADDY_INGRESS_DOCUMENTATION_URL}`);
    let parsed: ReturnType<typeof parseCaddyIngressArgument>;
    try { parsed = parseCaddyIngressArgument(JSON.stringify(parseIngressCliArguments("caddy", args, new Set(["domain", "listen-host", "listen-port", "dns-provider", "dns-argument", "acme-email"])))); }
    catch (error) { throw new UserError(error instanceof Error ? error.message : String(error)); }
    const selected = provider(context, parsed.dnsProvider);
    parsed.dnsArgument = normalizeDnsRecordArgument(dnsDriver(context.host, selected.driver), parsed.dnsArgument);
    return JSON.stringify({ ...parsed, listenPort: parsed.listenPort === "auto" ? await availableTcpPort(parsed.listenHost) : parsed.listenPort });
  },
  async runtime(argument, context) {
    const parsed = parseCaddyIngressArgument(argument), selected = provider(context, parsed.dnsProvider);
    dnsDriver(context.host, selected.driver);
    if (parsed.listenPort === "auto") throw new UserError("Caddy ingress has unresolved listenPort; re-add it with the DIM CLI");
    const ingress = { argument: { ...parsed, listenPort: parsed.listenPort }, provider: selected,
      routerPort: await availableTcpPort("127.0.0.1", new Set([parsed.listenPort])) };
    return { scheme: "https", domain: parsed.domain, ...(parsed.listenPort === 443 ? {} : { port: parsed.listenPort }),
      listenHost: "127.0.0.1", listenPort: ingress.routerPort,
      ...(parsed.routePolicy === undefined ? {} : { routePolicy: parsed.routePolicy }),
      approvalExposure: { listenHost: parsed.listenHost, listenPort: parsed.listenPort },
      initialize: (runtime, name) => reconcileManagedCaddy(context.host, runtime, name, ingress) };
  },
  dependencies(argument) { return [parseCaddyIngressArgument(argument).dnsProvider]; },
  async verify(argument, context) {
    const parsed = parseCaddyIngressArgument(argument), selected = provider(context, parsed.dnsProvider);
    await dnsDriver(context.host, selected.driver).verify(dnsOperation(selected, parsed)); await verifyCaddyIngress(parsed);
  },
  async remove(name, argument, runtime, context, cleanupDns) {
    if (cleanupDns) { const parsed = parseCaddyIngressArgument(argument), selected = provider(context, parsed.dnsProvider);
      await dnsDriver(context.host, selected.driver).remove(dnsOperation(selected, parsed)); }
    await stopManagedCaddy(runtime, name);
  },
  prune: removeStaleManagedCaddy
};

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

function dnsOperation(provider: ExternalUrlDnsProviderConfig, ingress: ReturnType<typeof parseCaddyIngressArgument>) {
  return {
    providerArgument: provider.argument,
    recordArgument: ingress.dnsArgument,
    domain: ingress.domain,
    env: process.env
  };
}

