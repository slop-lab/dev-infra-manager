import { identifier, object, privateFile, text } from "./config.js";

export interface RouterModel { id: string; name: string; api: "responses" | "chat"; context?: number; output?: number }
export interface RouterIssuerConnection { schemaVersion: 1; endpoint: string; issuerId: string; issuerKeyFile: string }
export interface PrincipalScope { bindingId: string; projectId: string; routeId: string; workspaceId: string; workspaceName: string }
export interface IssuedPrincipal { principalId: string; token: string; models: RouterModel[] }
export async function issuePrincipal(connection: RouterIssuerConnection, scope: PrincipalScope, signal: AbortSignal): Promise<IssuedPrincipal> {
  const response = await issuerRequest(connection, "/v1/host-principals", scope, signal);
  const row = object(await response.json());
  if (row.schemaVersion !== 1 || typeof row.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.token)
    || !Array.isArray(row.models) || !row.models.length) throw new Error("invalid issued router principal");
  const models = row.models.map((value: unknown): RouterModel => {
    const model = object(value);
    if (model.api !== "responses" && model.api !== "chat") throw new Error("invalid router model");
    return { id: text(model.id), name: text(model.name), api: model.api,
      ...(model.context === undefined ? {} : { context: positiveLimit(model.context) }),
      ...(model.output === undefined ? {} : { output: positiveLimit(model.output) }) };
  });
  return { principalId: identifier(row.principalId), token: row.token, models };
}
export async function revokePrincipal(connection: RouterIssuerConnection, scope: PrincipalScope, signal: AbortSignal): Promise<void> {
  await issuerRequest(connection, "/v1/host-principals/revoke", scope, signal);
}
async function issuerRequest(connection: RouterIssuerConnection, path: string, scope: PrincipalScope, signal: AbortSignal): Promise<Response> {
  const key = (await privateFile(connection.issuerKeyFile, 16 * 1024)).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("router issuer key must be a private 32-byte base64url secret");
  const response = await fetch(connection.endpoint + path, { method: "POST", redirect: "error", signal,
    headers: { authorization: `Basic ${Buffer.from(`${connection.issuerId}:${key}`).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify(scope) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`router principal operation denied (${response.status})`); }
  return response;
}

function positiveLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("invalid router model"); return value;
}
