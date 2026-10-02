import http from "node:http";
import path from "node:path";
import { getControlledRoute, setControlledRoute } from "./development-service-control.js";
import { withDevelopmentServiceLock } from "./development-service-lock.js";
import {
  type DevelopmentServiceRoute,
  isPort,
  parseAuthority
} from "./development-service-state.js";

const MAX_RESPONSE_BYTES = 65_536;

export type ExposeDevelopmentServiceOptions = {
  readonly name: string;
  readonly targetPort: number;
  readonly ingress: string;
  readonly requiredScheme?: "http" | "https";
  readonly developmentUrlSocket: string;
  readonly gatewayControlSocket: string;
};

type ExternalUrl = {
  readonly id: string;
  readonly ingress: string;
  readonly url: string;
  readonly permalink: string;
};

export async function exposeDevelopmentService(options: ExposeDevelopmentServiceOptions): Promise<string> {
  validateOptions(options);
  return withDevelopmentServiceLock(options.gatewayControlSocket, options.name, () => exposeLocked(options));
}

async function exposeLocked(options: ExposeDevelopmentServiceOptions): Promise<string> {
  const ingresses = await discoverIngresses(options.developmentUrlSocket);
  const selectedIngress = ingresses.find(({ name }) => name === options.ingress);
  if (selectedIngress === undefined) {
    throw new DevelopmentServiceExposureError(`external URL ingress '${options.ingress}' is unavailable`);
  }
  if (options.requiredScheme !== undefined && selectedIngress.scheme !== options.requiredScheme) {
    throw new DevelopmentServiceExposureError(
      `external URL ingress '${options.ingress}' requires scheme ${options.requiredScheme}`
    );
  }
  const currentRoute = await getControlledRoute(options.gatewayControlSocket, options.name);
  if (currentRoute !== undefined) {
    const urls = await listExternalUrls(options.developmentUrlSocket);
    const currentUrl = urls.find(({ id }) => id === currentRoute.urlId);
    const updated = currentUrl === undefined || currentUrl.ingress !== options.ingress
      ? undefined
      : adoptCurrentRoute(currentUrl, currentRoute, options);
    if (updated !== undefined) {
      await setControlledRoute(options.gatewayControlSocket, updated);
      return updated.url;
    }
  }
  const created = await createExternalUrl(options.developmentUrlSocket, options.ingress, options.name);
  if (created.ingress !== options.ingress) {
    throw new DevelopmentServiceExposureError("external URL response used an unexpected ingress");
  }
  const route = developmentServiceRoute(created, options);
  await setControlledRoute(options.gatewayControlSocket, route);
  return route.url;
}

async function discoverIngresses(
  socketPath: string
): Promise<readonly { readonly name: string; readonly scheme: "http" | "https" }[]> {
  const response = await developmentUrlRequest(socketPath, "GET", "/api");
  if (response.status !== 200 || !isObject(response.body) || !Array.isArray(response.body.routes)) {
    throw new DevelopmentServiceExposureError(`external URL discovery failed (${response.status})`);
  }
  const route = response.body.routes.find((value) => isObject(value)
    && value.path === "/api/urls"
    && isObject(value.discovery));
  if (!isObject(route) || !isObject(route.discovery) || !Array.isArray(route.discovery.ingresses)) return [];
  return route.discovery.ingresses.filter(isIngress);
}

async function listExternalUrls(socketPath: string): Promise<readonly ExternalUrl[]> {
  const response = await developmentUrlRequest(socketPath, "GET", "/api/urls");
  if (response.status !== 200 || !isObject(response.body) || !Array.isArray(response.body.urls)) {
    throw new DevelopmentServiceExposureError(`external URL list failed (${response.status})`);
  }
  return response.body.urls.filter(isExternalUrl);
}

async function createExternalUrl(socketPath: string, ingress: string, service: string): Promise<ExternalUrl> {
  const response = await developmentUrlRequest(socketPath, "POST", "/api/urls", { ingress, service });
  if (response.status !== 201 || !isObject(response.body) || !Array.isArray(response.body.urls)) {
    throw new DevelopmentServiceExposureError(`external URL registration failed (${response.status})`);
  }
  const created = response.body.urls[0];
  if (!isExternalUrl(created)) {
    throw new DevelopmentServiceExposureError("external URL registration returned no usable URL");
  }
  return created;
}

async function developmentUrlRequest(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: Readonly<Record<string, string>>
): Promise<{ readonly status: number; readonly body: unknown }> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: encoded === undefined ? {} : {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(encoded))
      },
      signal: AbortSignal.timeout(5_000)
    }, async (response) => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            throw new DevelopmentServiceExposureError("external URL response is too large");
          }
          chunks.push(buffer);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = text ? JSON.parse(text) : undefined;
        resolve({ status: response.statusCode ?? 500, body: parsed });
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}

function validateOptions(options: ExposeDevelopmentServiceOptions): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.name)) {
    throw new DevelopmentServiceExposureError("service name must use lowercase letters, digits, and hyphens");
  }
  if (!isPort(options.targetPort)) {
    throw new DevelopmentServiceExposureError("service port must be an integer between 1 and 65535");
  }
  if (!options.ingress) throw new DevelopmentServiceExposureError("external URL ingress is required");
  if (!path.isAbsolute(options.developmentUrlSocket)) {
    throw new DevelopmentServiceExposureError("DIM_DEVELOPMENT_URL_SOCKET must be an absolute path");
  }
}

function adoptCurrentRoute(
  externalUrl: ExternalUrl,
  currentRoute: DevelopmentServiceRoute,
  options: ExposeDevelopmentServiceOptions
): DevelopmentServiceRoute | undefined {
  try {
    const listedRoute = developmentServiceRoute(externalUrl, options);
    return listedRoute.permalink === currentRoute.permalink
      && listedRoute.permalinkAuthority === currentRoute.permalinkAuthority
      ? listedRoute
      : undefined;
  } catch (error) {
    if (error instanceof DevelopmentServiceExposureError) return undefined;
    throw error;
  }
}

function developmentServiceRoute(
  externalUrl: ExternalUrl,
  options: ExposeDevelopmentServiceOptions
): DevelopmentServiceRoute {
  const parsed = parseExternalUrl(externalUrl.url, options.requiredScheme);
  const parsedPermalink = parseExternalUrl(externalUrl.permalink, options.requiredScheme);
  return {
    name: options.name,
    urlId: externalUrl.id,
    url: parsed.url,
    authority: parsed.authority,
    permalink: parsedPermalink.url,
    permalinkAuthority: parsedPermalink.authority,
    ingress: externalUrl.ingress,
    targetPort: options.targetPort
  };
}

function parseExternalUrl(
  value: string,
  requiredScheme?: "http" | "https"
): { readonly url: string; readonly authority: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new DevelopmentServiceExposureError("external URL response contained an invalid URL", error);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new DevelopmentServiceExposureError("external URL response contained an invalid URL");
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (requiredScheme !== undefined && scheme !== requiredScheme) {
    throw new DevelopmentServiceExposureError(`external URL response requires scheme ${requiredScheme}`);
  }
  return { url: parsed.origin, authority: parseAuthority(parsed.host) };
}

function isIngress(value: unknown): value is { readonly name: string; readonly scheme: "http" | "https" } {
  return isObject(value)
    && typeof value.name === "string"
    && (value.scheme === "http" || value.scheme === "https");
}

function isExternalUrl(value: unknown): value is ExternalUrl {
  return isObject(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.ingress === "string"
    && typeof value.url === "string"
    && typeof value.permalink === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DevelopmentServiceExposureError extends Error {
  readonly name = "DevelopmentServiceExposureError";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
