import http from "node:http";
import https from "node:https";
import { UserError, type ControllerWorkspace } from "@slop-lab/dim-core";

export type ExternalUrlRoutePolicyConfig =
  | { driver: "workspace-prefix" }
  | { driver: "webhook"; argument: string };

export interface ExternalUrlRoutePolicyRequest {
  workspace: Pick<ControllerWorkspace, "id" | "name">;
  ingress: string;
  requestedSubdomain: string;
  domain: string;
}

export function parseRoutePolicy(
  value: unknown,
  error: (detail: string) => Error = (detail) => new Error(`routePolicy ${detail}`)
): ExternalUrlRoutePolicyConfig {
  if (!isRecord(value) || typeof value.driver !== "string") {
    throw error("field 'routePolicy' must contain a string driver");
  }
  if (value.driver === "workspace-prefix") return { driver: "workspace-prefix" };
  if (value.driver !== "webhook") throw error("field 'routePolicy.driver' must be workspace-prefix or webhook");
  if (typeof value.argument !== "string") throw error("webhook routePolicy requires string field 'argument'");
  parseWebhookArgument(value.argument, error);
  return { driver: "webhook", argument: value.argument };
}

export async function applyRoutePolicy(
  config: ExternalUrlRoutePolicyConfig | undefined,
  request: ExternalUrlRoutePolicyRequest
): Promise<string> {
  if (!config || config.driver === "workspace-prefix") {
    if (!request.requestedSubdomain.startsWith(workspaceSubdomainPrefix(request.workspace.name))) {
      throw new UserError(
        `subdomain '${request.requestedSubdomain}' must start with `
        + `'${workspaceSubdomainPrefix(request.workspace.name)}'`
      );
    }
    return request.requestedSubdomain;
  }
  const response = await callWebhook(parseWebhookArgument(config.argument), request);
  if (!response.allow) throw new UserError(response.reason ?? "external URL route policy rejected the requested subdomain");
  return response.subdomain ?? request.requestedSubdomain;
}

export function workspaceSubdomainPrefix(workspaceName: string): string {
  const normalized = workspaceName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  if (normalized.length <= 50) return `${normalized}--`;
  return `${normalized.slice(0, 41)}-${stableHash(normalized).toString(16).padStart(8, "0")}--`;
}

function parseWebhookArgument(
  argument: string,
  error: (detail: string) => Error = (detail) => new Error(`webhook routePolicy ${detail}`)
): { url: URL; socketPath?: string } {
  let value: unknown;
  try {
    value = JSON.parse(argument);
  } catch {
    throw error("webhook routePolicy argument must be valid JSON");
  }
  if (!isRecord(value) || typeof value.url !== "string") {
    throw error("webhook routePolicy argument requires string field 'url'");
  }
  if (value.url.startsWith("unix:")) {
    const socketPath = value.url.slice("unix:".length);
    if (!socketPath.startsWith("/")) throw error("webhook unix URL must contain an absolute socket path");
    return { url: new URL("http://localhost/"), socketPath };
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw error("webhook routePolicy URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw error("webhook URL must use http, https, or unix");
  }
  return { url };
}

async function callWebhook(
  endpoint: { url: URL; socketPath?: string },
  input: ExternalUrlRoutePolicyRequest
): Promise<{ allow: boolean; reason?: string; subdomain?: string }> {
  const body = JSON.stringify(input);
  const maxResponseBytes = 64 * 1024;
  const transport = endpoint.url.protocol === "https:" ? https : http;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = transport.request({
      ...(endpoint.socketPath === undefined
        ? {
            hostname: endpoint.url.hostname,
            port: endpoint.url.port || undefined
          }
        : { socketPath: endpoint.socketPath }),
      path: `${endpoint.url.pathname || "/"}${endpoint.url.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      },
      timeout: 5_000
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on("data", (chunk) => {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > maxResponseBytes) {
          incoming.destroy(new Error("external URL route policy webhook response exceeds 64 KiB"));
          return;
        }
        chunks.push(value);
      });
      incoming.once("error", reject);
      incoming.on("end", () => resolve({
        status: incoming.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("timeout", () => request.destroy(new Error("external URL route policy webhook timed out")));
    request.once("error", reject);
    request.end(body);
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`external URL route policy webhook returned ${response.status}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new Error("external URL route policy webhook returned invalid JSON");
  }
  if (!isRecord(value) || typeof value.allow !== "boolean"
    || (value.reason !== undefined && typeof value.reason !== "string")
    || (typeof value.reason === "string" && value.reason.length > 1024)
    || (value.subdomain !== undefined && typeof value.subdomain !== "string")
    || (typeof value.subdomain === "string" && value.subdomain.length > 253)) {
    throw new Error("external URL route policy webhook returned an invalid response");
  }
  return value as { allow: boolean; reason?: string; subdomain?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
