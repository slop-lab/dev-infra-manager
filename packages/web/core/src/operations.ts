import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { HttpResponseError } from "./http-response.js";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const repositoryId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const file = z.string().refine(isAbsolute);
export const operationsConfigSchema = z.object({
  hosts: z.array(z.object({ id: identifier, selector: identifier, executable: file }).strict()).max(64).default([]),
  consoles: z.array(z.object({ name: z.string().min(1).max(128), url: z.string().url().refine((value) => {
    const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
  }) }).strict()).max(64).default([])
}).strict().refine((value) => new Set(value.hosts.map((host) => host.id)).size === value.hosts.length);
export type OperationsConfig = z.infer<typeof operationsConfigSchema>;
const resourcesSchema = z.object({
  cpuCount: z.string().regex(/^(?:unlimited|[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/).max(32).optional(),
  memory: z.union([z.literal("unlimited"), z.string().regex(/^[1-9][0-9]*(?:[bkmg]|[kmgt]i?b)?$/i).max(32)]).optional(),
  pidsLimit: z.string().regex(/^(?:unlimited|[1-9][0-9]*)$/).max(16).optional()
}).strict();
export const workspaceCreateSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/),
  source: z.string().min(1).max(4096).refine((value) => {
    if (/^dim:\/\/[a-z0-9][a-z0-9-]*\/?$/.test(value)) return true;
    if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
    try { const url = new URL(value); return ["https:", "http:", "ssh:", "git:"].includes(url.protocol) && Boolean(url.hostname) && !url.hash; }
    catch { return false; }
  }, "use an HTTP(S), SSH or Git repository URL, or dim://PROJECT"),
  ref: z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*$/).optional(),
  runtime: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).default("container"),
  image: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/).optional(),
  resources: resourcesSchema.optional(),
  repositories: z.array(repositoryId).min(1).max(64).refine((ids) => new Set(ids).size === ids.length).optional(),
  workingDirectory: repositoryId.optional()
}).strict().refine((value) => value.source.startsWith("dim://") || (value.repositories === undefined && value.workingDirectory === undefined), "repository selection requires dim://PROJECT");
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;
export const workspaceActionSchema = z.object({ name: identifier, expectedId: z.string().uuid(),
  action: z.enum(["start", "stop", "restart", "recreate", "discard", "resources"]), resources: resourcesSchema.optional()
}).strict().refine((value) => value.action === "resources" ? value.resources !== undefined && Object.keys(value.resources).length > 0 : value.resources === undefined);
export const workspaceSummarySchema = z.object({ id: z.string().uuid(), name: identifier, runtime: z.string(),
  phase: z.enum(["creating", "running", "stopped", "error", "discarding"]), runtimeStatus: z.string(),
  resources: z.object({ cpuCount: z.string(), memory: z.string(), pidsLimit: z.string() }).strict() });
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export interface WebOperations {
  hosts(): Promise<unknown>;
  workspaces(host: string): Promise<unknown>;
  workspaceAction(host: string, input: WorkspaceAction): Promise<void>;
  workspaceCreate(host: string, input: WorkspaceCreate): Promise<void>;

}
const execute = promisify(execFile);
export function configuredWebOperations(config: OperationsConfig): WebOperations {
  function host(id: string) {
    const selected = config.hosts.find((host) => host.id === id);
    if (!selected) throw new HttpResponseError(404, "host not found");
    return selected;
  }
  async function command(id: string, args: string[], timeout = 30_000): Promise<unknown> {
    const selected = host(id);
    try {
      const result = await execute(selected.executable, ["--host", selected.selector, ...args, "--json"], {
        timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true
      });
      return JSON.parse(result.stdout);
    } catch { throw new HttpResponseError(409, "host operation failed; refresh the workspace before retrying"); }
  }
  return {
    async hosts() { return config.hosts.map(({ id }) => ({ id })); },
    async workspaces(id) { return z.array(workspaceSummarySchema).max(1024).parse(await command(id, ["ls"])); },
    async workspaceCreate(id, input) {
      const value = workspaceCreateSchema.parse(input);
      const args = ["create", value.source, value.name, "--runtime", value.runtime];
      for (const repositoryId of value.repositories ?? []) args.push("--repository", repositoryId);
      if (value.workingDirectory !== undefined) args.push("--workdir", value.workingDirectory);
      if (value.ref !== undefined) args.push("--ref", value.ref);
      if (value.image !== undefined) args.push("--image", value.image);
      for (const [key, flag] of [["cpuCount", "--cpus"], ["memory", "--memory"], ["pidsLimit", "--pids"]] as const) {
        const limit = value.resources?.[key]; if (limit !== undefined) args.push(flag, limit);
      }
      await command(id, args, 300_000);
    },
    async workspaceAction(id, input) {
      const args = [input.action, input.name, "--expect-id", input.expectedId];
      for (const [key, flag] of [["cpuCount", "--cpus"], ["memory", "--memory"], ["pidsLimit", "--pids"]] as const) {
        const value = input.resources?.[key]; if (value !== undefined) args.push(flag, value);
      }
      await command(id, args);
    }
  };
}
