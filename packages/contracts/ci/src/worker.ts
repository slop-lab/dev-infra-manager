import { isAbsolute } from "node:path";
import { z } from "zod";

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === value && url.username === "" && url.password === ""
      && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
});
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const executionWorkerConfigSchema = z.object({ schemaVersion: z.literal(1), workerId: identifier,
  generationId: z.string().regex(/^[0-9a-f]{64}$/), stateDirectory: z.string().refine(isAbsolute),
  gitExecutable: z.string().refine(isAbsolute).optional(), endpoint: origin, nativeGitEndpoint: origin.optional(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43,}$/), slots: z.array(z.union([z.object({ id: identifier,
    runtime: z.enum(["container", "vm"]) }).strict().readonly(), z.object({ id: identifier, taskType: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      handlerRevision: z.string().regex(/^[0-9a-f]{64}$/) }).strict().readonly()])).min(1).readonly()
}).strict().readonly().refine((config) => new Set(config.slots.map((slot) => slot.id)).size === config.slots.length)
  .refine((config) => !config.slots.some((slot) => "runtime" in slot) || (config.gitExecutable !== undefined && config.nativeGitEndpoint !== undefined), "CI slots require Git executable and native Git endpoint");
