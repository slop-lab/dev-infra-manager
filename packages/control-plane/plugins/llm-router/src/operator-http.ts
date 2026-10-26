import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { llmOperation } from "@slop-lab/dim-contracts-llm-router";
import { privateFile, type RouterConfig } from "./config.js";
import { hash, type RouterLedger } from "./ledger.js";
import { invokeRouterOperation } from "./operations.js";
import { RouterOperationRejectedError } from "./operation-errors.js";
import { RequestError, body, send } from "./http.js";
export async function handleRouterOperator(config: RouterConfig, ledger: RouterLedger, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dim-llm-operator");
  if (!url.pathname.startsWith("/v1/operator/operations/")) throw new RequestError(404, "unsupported operator endpoint");
  if (request.method !== "POST" || url.search !== "") throw new RequestError(404, "unsupported operator endpoint");
  const credential = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.authorization ?? "")?.[1];
  const decoded = credential === undefined ? "" : Buffer.from(credential, "base64").toString("utf8");
  const actor = config.operators?.find(({ id }) => decoded.startsWith(id + ":"));
  if (!actor) throw new RequestError(401, "operator authentication failed", "authentication_failed");
  let expected: string;
  try { expected = (await privateFile(actor.keyFile, 16 * 1024)).trim(); }
  catch { throw new RequestError(401, "operator authentication failed", "authentication_failed"); }
  const supplied = decoded.slice(actor.id.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(expected) || !timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(expected)))) throw new RequestError(401, "operator authentication failed", "authentication_failed");
  // Even an accidentally duplicated secret must not turn an issuer or workspace key into an operator key.
  if (ledger.database.prepare("SELECT 1 FROM principals WHERE token_hash=? LIMIT 1").get(hash(expected))) throw new RequestError(401, "operator credential must be dedicated", "authentication_failed");
  for (const other of [...config.hostIssuers, ...config.accounts, ...(config.operators ?? []).filter((other) => other.id !== actor.id)]) {
    let otherKey: string;
    try { otherKey = (await privateFile(other.keyFile, 16 * 1024)).trim(); }
    catch { continue; } // An unavailable unrelated backend key must not disable operator diagnostics.
    if (otherKey === expected) throw new RequestError(401, "operator credential must be dedicated", "authentication_failed");
  }
  const name = url.pathname.slice("/v1/operator/operations/".length);
  let operation;
  try { operation = llmOperation(name); } catch { throw new RequestError(404, "unknown operator operation"); }
  if (operation.access !== "read" && actor.role !== "operator") throw new RequestError(403, "operator permission denied", "authorization_failed");
  let input: unknown;
  try { input = operation.parseInput(JSON.parse((await body(request, 64 * 1024)).toString("utf8")) as unknown); } catch { throw new RequestError(400, "invalid operator input"); }
  try { return send(response, 200, await invokeRouterOperation(config, ledger, name, input, actor.id, actor.role)); }
  catch (error) {
    if (error instanceof RouterOperationRejectedError) throw new RequestError(409, "operator operation rejected; refresh current state before retrying", "operation_failed");
    throw new RequestError(503, "operator operation result unavailable; refresh current state before retrying", "operation_result_unknown");
  }
}
