import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin";
import { parseNativeGitBundleConfig } from "./bundle-config.js";
import { configuredNativeGitBundleServer } from "./native-bundle-server.js";

const configuration = z.object({
  service: z.unknown(),
  stateDirectory: z.string().refine(isAbsolute),
  readinessToken: z.string().regex(/^[A-Za-z0-9_-]+$/).min(32),
  activationToken: z.string().regex(/^[A-Za-z0-9_-]+$/).min(32),
  expectedGenerationId: z.string().regex(/^[0-9a-f]{64}$/),
  listen: z.object({ host: z.string().min(1), port: z.number().int().min(0).max(65_535) }).strict().optional()
}).strict();

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "native-git",
  configure(raw) {
    const parsed = configuration.parse(raw);
    const config = parseNativeGitBundleConfig(parsed.service);
    return {
      requiresWorkflowCompiler: true,
      async start(context) {
        context.signal.throwIfAborted();
        if (context.workflowCompiler === undefined) throw new Error("native-git requires a workflow compiler plugin");
        const service = await configuredNativeGitBundleServer({ config, stateDirectory: parsed.stateDirectory,
          readinessToken: parsed.readinessToken, activationToken: parsed.activationToken,
          expectedGenerationId: parsed.expectedGenerationId, workflowCompiler: context.workflowCompiler });
        try {
          context.signal.throwIfAborted();
          await service.listen(parsed.listen?.host, parsed.listen?.port);
          context.signal.throwIfAborted();
          return { close: () => service.close() };
        } catch (error) {
          try { await service.close(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "native Git startup and cleanup failed"); }
          throw error;
        }
      }
    };
  }
};
