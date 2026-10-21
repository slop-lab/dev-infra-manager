import type { ExternalUrlIngressDriver } from "./plugin-api.js";
import { UserError } from "@slop-lab/dim-host-core";
import { parseRoutePolicy, type ExternalUrlRoutePolicyConfig } from "./routePolicy.js";
import { availableTcpPort, parseIngressCliArguments } from "./ingressDriver.js";

export const httpIngressDriver: ExternalUrlIngressDriver = {
  async configure(scheme, args) {
    if (scheme !== "http" && scheme !== "https") throw new UserError("HTTP ingress requires scheme http or https");
    const parsed = parseHttpIngressArgument(JSON.stringify(parseIngressCliArguments("http", args, new Set(["domain", "listen-host", "listen-port", "public-port"]))));
    return JSON.stringify({ ...parsed, listenPort: parsed.listenPort === "auto" ? await availableTcpPort(parsed.listenHost) : parsed.listenPort });
  },
  async runtime(argument, _context, scheme) {
    const parsed = parseHttpIngressArgument(argument);
    if (parsed.listenPort === "auto") throw new UserError("HTTP ingress has unresolved listenPort 'auto'; re-add it with the DIM CLI");
    if (scheme !== "http" && scheme !== "https") throw new UserError("HTTP ingress requires scheme http or https");
    return { scheme, domain: parsed.domain, listenHost: parsed.listenHost, listenPort: parsed.listenPort,
      ...(parsed.publicPort === undefined ? {} : { port: parsed.publicPort }),
      ...(parsed.routePolicy === undefined ? {} : { routePolicy: parsed.routePolicy }) };
  },
  async verify(argument) { parseHttpIngressArgument(argument); }
};

function parseHttpIngressArgument(argument: string): {
  domain: string;
  listenHost: string;
  listenPort: number | "auto";
  publicPort?: number;
  routePolicy?: ExternalUrlRoutePolicyConfig;
} {
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
  if (input.upstreamMode !== undefined) {
    throw httpIngressArgumentError("field 'upstreamMode' is unsupported; targets always use the owned workspace relay");
  }
  return {
    ...input,
    ...(input.routePolicy === undefined
      ? {}
      : { routePolicy: parseRoutePolicy(input.routePolicy, httpIngressArgumentError) })
  } as unknown as ReturnType<typeof parseHttpIngressArgument>;
}

const INGRESS_DOCUMENTATION_URL =
  "https://github.com/slop-lab/dev-infra-manager/blob/main/docs/guides/external-urls.md#host-configuration-and-route-approval";

function httpIngressArgumentError(detail: string): UserError {
  return new UserError(`http ingress arguments ${detail}. See ${INGRESS_DOCUMENTATION_URL}`);
}

