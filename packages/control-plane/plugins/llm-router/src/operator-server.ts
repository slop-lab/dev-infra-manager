import { createServer } from "node:http";
import { join } from "node:path";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import type { RouterConfig } from "./config.js";
import { RouterLedger } from "./ledger.js";
import { handleRouterOperator } from "./operator-http.js";
import { closeManagedLogins } from "./managed-backend.js";
import { RequestError, send } from "./http.js";
/** Independent operator listener. It never owns inference recovery or workspace admission. */
export async function createRouterOperatorServer(config: RouterConfig) {
  if (!config.operators?.length) throw new Error("operator service requires at least one configured operator actor");
  const ledger = RouterLedger.openShared(config.stateDirectory);
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "operator-service.guard"), { timeoutMilliseconds: 2000 });
  if (!guard) { ledger.close(); throw new Error("router operator service is already running for this state directory"); }
  const active = new Set<Promise<void>>(); let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const pending = handleRouterOperator(config, ledger, request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else send(response, error instanceof RequestError ? error.status : 503, { error: { category: error instanceof RequestError ? error.category : "service_unavailable", message: error instanceof RequestError ? error.message : "router operator service unavailable" } });
    });
    active.add(pending); void pending.finally(() => active.delete(pending));
  });
  server.maxConnections = 32; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
  return { server, ledger, close() { return closing ??= (async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(active); await closeManagedLogins(config); ledger.close(); await guard.release();
  })(); } };
}
