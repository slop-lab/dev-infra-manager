import { once } from "node:events";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { executionServiceConfigSchema } from "./config.js";
import { configuredExecutionServer } from "./service.js";

const configuration = z.object({
  service: executionServiceConfigSchema,
  stateDirectory: z.string().refine(isAbsolute),
  readinessToken: z.string().regex(/^[A-Za-z0-9_-]+$/).min(32),
  activationToken: z.string().regex(/^[A-Za-z0-9_-]+$/).min(32),
  expectedGenerationId: z.string().regex(/^[0-9a-f]{64}$/),
  listen: z.object({ host: z.string().min(1), port: z.number().int().min(0).max(65_535) }).strict().optional()
}).strict();

/** The coordinator owns admission/leases/results; it never acquires host runtime resources. */
export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "execution-scheduler",
  configure(raw) {
    const parsed = configuration.parse(raw);
    return { async start({ signal }) {
      signal.throwIfAborted();
      const service = configuredExecutionServer({ config: parsed.service, stateDirectory: parsed.stateDirectory,
        readinessToken: parsed.readinessToken, activationToken: parsed.activationToken,
        expectedGenerationId: parsed.expectedGenerationId });
      try {
        signal.throwIfAborted();
        service.server.listen(parsed.listen?.port ?? 8080, parsed.listen?.host ?? "0.0.0.0");
        await once(service.server, "listening", { signal });
        signal.throwIfAborted();
        return { close: () => service.close() };
      } catch (error) {
        try { await service.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Execution scheduler startup and cleanup failed"); }
        throw error;
      }
    } };
  }
};
export { configuredExecutionServer } from "./service.js";
export { ExecutionStore } from "./store.js";
export { inspectExecutionState } from "./state.js";
export { GitExecutionAuthorityError, nativeGitExecutionSource, StaleExecutionSourceError } from "./ci-source.js";
export type { ExecutionSource } from "./ci-source.js";
