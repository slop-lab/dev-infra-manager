import type {
  ControllerProxyCapability,
  ControllerProxyRequest,
  ControllerProxyResponse,
  ControllerProxyUpstream
} from "./index.js";

export interface ExternalUrlIngress {
  readonly name: string;
  readonly description: string;
  readonly scheme: "http" | "https" | "tcp";
}

export interface ExternalUrlProxyOptions {
  readonly allowedIngresses: readonly string[];
  readonly boundTarget?: ExternalUrlTarget;
  readonly boundServiceSubdomains?: Readonly<Record<string, string>>;
}

export interface ExternalUrlTarget {
  readonly containers: readonly string[];
  readonly protocol: "http" | "https" | "tcp";
  readonly port: number;
}

export function externalUrlProxy(options: ExternalUrlProxyOptions): ControllerProxyCapability {
  const allowed = new Set(options.allowedIngresses);
  if (allowed.size === 0) throw new Error("external URL proxy requires at least one allowed ingress");
  const boundTargetKey = options.boundTarget === undefined ? undefined : targetKey(options.boundTarget);
  if (options.boundTarget !== undefined && boundTargetKey === undefined) {
    throw new Error("external URL proxy received an invalid bound target");
  }
  const serviceSubdomains = new Map(Object.entries(options.boundServiceSubdomains ?? {}));
  if (serviceSubdomains.size > 0 && options.boundTarget === undefined) {
    throw new Error("external URL proxy service subdomains require a bound target");
  }
  for (const [service, subdomain] of serviceSubdomains) {
    if (!isServiceName(service) || !isSubdomain(subdomain)) {
      throw new Error("external URL proxy received an invalid service subdomain binding");
    }
  }
  const allowedSubdomains = new Set(serviceSubdomains.values());
  const isAllowed = (entry: Record<string, unknown>): boolean =>
    typeof entry.ingress === "string"
    && allowed.has(entry.ingress)
    && (boundTargetKey === undefined || boundTargetKey === targetKey(entry.target))
    && (allowedSubdomains.size === 0
      || (typeof entry.subdomain === "string" && allowedSubdomains.has(entry.subdomain)));
  return {
    async authorize(request, upstream) {
      if (request.method === "GET" && request.path === "/api") return true;
      if (request.method === "GET" && request.path === "/api/urls") return true;
      if (request.method === "POST" && request.path === "/api/urls") {
        const body = jsonObject(request.body);
        if (typeof body.ingress !== "string" || !allowed.has(body.ingress)) return false;
        if (boundTargetKey === undefined) return true;
        const service = body.service;
        if (serviceSubdomains.size === 0) {
          const keys = Object.keys(body);
          if (!Object.hasOwn(body, "ingress")
            || (keys.length !== 1 && !(keys.length === 2 && typeof service === "string"
              && isServiceName(service) && Object.hasOwn(body, "service")))) return false;
        } else if (typeof service !== "string"
          || !serviceSubdomains.has(service)
          || Object.keys(body).length !== 2
          || !Object.hasOwn(body, "ingress")
          || !Object.hasOwn(body, "service")) return false;
        return (await currentIngresses(upstream)).some((ingress) =>
          ingress.name === body.ingress && compatibleScheme(options.boundTarget, ingress.scheme));
      }
      const match = request.method === "DELETE" && request.path.match(/^\/api\/urls\/([^/]+)$/);
      if (!match) return false;
      const id = decodeURIComponent(match[1] as string);
      return (await currentUrls(upstream)).some((entry) => entry.id === id && isAllowed(entry));
    },
    transformRequest(request) {
      if (options.boundTarget === undefined
        || request.method !== "POST"
        || request.path !== "/api/urls") return request;
      return {
        ...request,
        body: Buffer.from(JSON.stringify({
          ingress: jsonObject(request.body).ingress,
          ...(serviceSubdomains.size === 0
            ? {}
            : { subdomain: serviceSubdomains.get(String(jsonObject(request.body).service)) }),
          target: options.boundTarget
        }))
      };
    },
    filterResponse(request, response) {
      if (request.method !== "GET" || response.status !== 200) return response;
      if (request.path === "/api") {
        const body = jsonObject(response.body);
        const routes = Array.isArray(body.routes)
          ? body.routes.filter(isExternalUrlRoute).map((route) => ({
            ...route,
            ...(isObject(route.discovery)
              ? {
                discovery: {
                  ...route.discovery,
                  ingresses: Array.isArray(route.discovery.ingresses)
                    ? route.discovery.ingresses.filter((ingress) =>
                       isIngress(ingress) && allowed.has(ingress.name)
                       && compatibleScheme(options.boundTarget, ingress.scheme))
                    : []
                }
              }
              : {})
          }))
          : [];
        return jsonResponse(response, { ...body, routes, hostInputProviders: [] });
      }
      if (request.path !== "/api/urls") return response;
      const body = jsonObject(response.body);
      const urls = Array.isArray(body.urls)
        ? body.urls.filter((entry) => isObject(entry) && isAllowed(entry))
        : [];
      return jsonResponse(response, { ...body, urls });
    }
  };
}

function isServiceName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function isSubdomain(value: string): boolean {
  return value.length > 0
    && value.length <= 253
    && !value.endsWith(".")
    && value.split(".").every((label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function targetKey(value: unknown): string | undefined {
  if (!isObject(value)
    || !Array.isArray(value.containers)
    || value.containers.length > 2
    || !value.containers.every((container) => typeof container === "string" && container.length > 0)
    || (value.protocol !== "http" && value.protocol !== "https" && value.protocol !== "tcp")
    || typeof value.port !== "number"
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65_535) {
    return undefined;
  }
  return JSON.stringify([value.containers, value.protocol, value.port]);
}

export async function getExternalUrlIngresses(options: {
  sourceSocket?: string;
  token?: string;
} = {}): Promise<ExternalUrlIngress[]> {
  const sourceSocket = options.sourceSocket ?? process.env.DIM_CONTROLLER_SOCKET;
  const token = options.token ?? process.env.DIM_CONTROLLER_TOKEN;
  if (!sourceSocket || !token) throw new Error("controller socket and token are required");
  const response = await rawRequest(sourceSocket, token, "GET", "/api");
  if (response.status !== 200) throw new Error(`controller discovery failed (${response.status})`);
  const body = jsonObject(response.body);
  if (!Array.isArray(body.routes)) return [];
  const route = body.routes.find((candidate) =>
    isObject(candidate) && candidate.path === "/api/urls" && isObject(candidate.discovery));
  if (!isObject(route) || !isObject(route.discovery) || !Array.isArray(route.discovery.ingresses)) return [];
  return route.discovery.ingresses.filter(isIngress);
}

async function currentUrls(upstream: ControllerProxyUpstream): Promise<Record<string, unknown>[]> {
  const response = await upstream.request("GET", "/api/urls");
  if (response.status !== 200) return [];
  const body = jsonObject(response.body);
  return Array.isArray(body.urls) ? body.urls.filter(isObject) : [];
}

function jsonObject(body: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (isObject(value)) return value;
  } catch {}
  throw new Error("controller proxy expected a JSON object");
}

function jsonResponse(
  response: ControllerProxyResponse,
  body: Record<string, unknown>
): ControllerProxyResponse {
  return {
    status: response.status,
    headers: { ...response.headers, "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(`${JSON.stringify(body)}\n`)
  };
}

function isIngress(value: unknown): value is ExternalUrlIngress {
  return isObject(value)
    && typeof value.name === "string"
    && typeof value.description === "string"
    && (value.scheme === "http" || value.scheme === "https" || value.scheme === "tcp");
}

async function currentIngresses(upstream: ControllerProxyUpstream): Promise<ExternalUrlIngress[]> {
  const response = await upstream.request("GET", "/api");
  if (response.status !== 200) return [];
  const body = jsonObject(response.body);
  if (!Array.isArray(body.routes)) return [];
  const route = body.routes.find((candidate) =>
    isObject(candidate) && candidate.path === "/api/urls" && isObject(candidate.discovery));
  if (!isObject(route) || !isObject(route.discovery) || !Array.isArray(route.discovery.ingresses)) return [];
  return route.discovery.ingresses.filter(isIngress);
}

function compatibleScheme(target: ExternalUrlTarget | undefined, scheme: ExternalUrlIngress["scheme"]): boolean {
  if (target === undefined) return true;
  return target.protocol === "tcp" ? scheme === "tcp" : scheme !== "tcp";
}

function isExternalUrlRoute(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.path === "/api/urls";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawRequest(
  socketPath: string,
  token: string,
  method: string,
  requestPath: string
): Promise<ControllerProxyResponse> {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ default: http }) => {
      const request = http.request({
        socketPath,
        method,
        path: requestPath,
        headers: { authorization: `Bearer ${token}` }
      }, async (response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        resolve({
          status: response.statusCode ?? 500,
          headers: response.headers,
          body: Buffer.concat(chunks)
        });
      });
      request.once("error", reject);
      request.end();
    }).catch(reject);
  });
}
