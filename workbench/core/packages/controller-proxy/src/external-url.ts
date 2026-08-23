import type {
  ControllerProxyCapability,
  ControllerProxyRequest,
  ControllerProxyResponse,
  ControllerProxyUpstream
} from "./index.js";

export interface ExternalUrlIngress {
  readonly name: string;
  readonly description: string;
  readonly scheme: "http" | "https";
}

export interface ExternalUrlProxyOptions {
  readonly allowedIngresses: readonly string[];
}

export function externalUrlProxy(options: ExternalUrlProxyOptions): ControllerProxyCapability {
  const allowed = new Set(options.allowedIngresses);
  if (allowed.size === 0) throw new Error("external URL proxy requires at least one allowed ingress");
  return {
    async authorize(request, upstream) {
      if (request.method === "GET" && request.path === "/api") return true;
      if (request.method === "GET" && request.path === "/api/urls") return true;
      if (request.method === "POST" && request.path === "/api/urls") {
        const body = jsonObject(request.body);
        return typeof body.ingress === "string" && allowed.has(body.ingress);
      }
      const match = request.method === "DELETE" && request.path.match(/^\/api\/urls\/([^/]+)$/);
      if (!match) return false;
      const id = decodeURIComponent(match[1] as string);
      return (await currentUrls(upstream)).some((entry) =>
        entry.id === id && typeof entry.ingress === "string" && allowed.has(entry.ingress));
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
                      isIngress(ingress) && allowed.has(ingress.name))
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
        ? body.urls.filter((entry) =>
          isObject(entry) && typeof entry.ingress === "string" && allowed.has(entry.ingress))
        : [];
      return jsonResponse(response, { ...body, urls });
    }
  };
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
    && (value.scheme === "http" || value.scheme === "https");
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
