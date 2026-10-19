import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { HttpResponseError } from "./http-response.js";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const file = z.string().refine(isAbsolute);
export const operationsConfigSchema = z.object({
  hosts: z.array(z.object({ id: identifier, selector: identifier, executable: file }).strict()).max(64).default([]),
  ci: z.object({ queryConnection: file, operatorConnection: file.optional() }).strict().optional(),
  consoles: z.array(z.object({ name: z.string().min(1).max(128), url: z.string().url().refine((value) => {
    const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
  }) }).strict()).max(64).default([])
}).strict().refine((value) => new Set(value.hosts.map((host) => host.id)).size === value.hosts.length);
export type OperationsConfig = z.infer<typeof operationsConfigSchema>;
export const workspaceActionSchema = z.object({ name: identifier, expectedId: z.string().uuid(),
  action: z.enum(["start", "stop", "restart", "recreate", "discard", "resources"]),
  resources: z.object({ cpuCount: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/).max(32).optional(),
    memory: z.string().regex(/^[1-9][0-9]*(?:[kmg]i?b?)?$/i).max(32).optional(),
    pidsLimit: z.string().regex(/^[1-9][0-9]*$/).max(16).optional() }).strict().optional()
}).strict().refine((value) => value.action === "resources" ? value.resources !== undefined && Object.keys(value.resources).length > 0 : value.resources === undefined);
export const workspaceSummarySchema = z.object({ id: z.string().uuid(), name: identifier, runtime: z.string(),
  phase: z.enum(["creating", "running", "stopped", "error", "discarding"]), runtimeStatus: z.string(),
  resources: z.object({ cpuCount: z.string(), memory: z.string(), pidsLimit: z.string() }).strict() });
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export interface WebOperations {
  hosts(): Promise<unknown>;
  workspaces(host: string): Promise<unknown>;
  workspaceAction(host: string, input: WorkspaceAction): Promise<void>;
  jobs(): Promise<unknown>;
  detail(id: string): Promise<unknown>;
  workers(): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  retry(id: string, requestId: string): Promise<unknown>;
}
const execute = promisify(execFile);
export function configuredWebOperations(config: OperationsConfig): WebOperations {
  function host(id: string) {
    const selected = config.hosts.find((host) => host.id === id);
    if (!selected) throw new HttpResponseError(404, "host not found");
    return selected;
  }
  async function command(id: string, args: string[]): Promise<unknown> {
    const selected = host(id);
    try {
      const result = await execute(selected.executable, ["--host", selected.selector, ...args, "--json"], {
        timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true
      });
      return JSON.parse(result.stdout);
    } catch { throw new HttpResponseError(409, "host operation failed; refresh the workspace before retrying"); }
  }
  async function ci() {
    if (!config.ci) throw new HttpResponseError(404, "CI is not configured");
    const module = await import("@slop-lab/dim-managed/ci");
    return module.createCiQueryClient(config.ci.queryConnection);
  }
  async function operator() {
    if (!config.ci?.operatorConnection) throw new HttpResponseError(403, "CI operator connection is not configured");
    const module = await import("@slop-lab/dim-managed/ci");
    return module.createCiOperatorClient(config.ci.operatorConnection);
  }
  return {
    async hosts() { return config.hosts.map(({ id }) => ({ id })); },
    async workspaces(id) { return z.array(workspaceSummarySchema).max(1024).parse(await command(id, ["ls"])); },
    async workspaceAction(id, input) {
      const args = [input.action, input.name, "--expect-id", input.expectedId];
      for (const [key, flag] of [["cpuCount", "--cpus"], ["memory", "--memory"], ["pidsLimit", "--pids"]] as const) {
        const value = input.resources?.[key]; if (value !== undefined) args.push(flag, value);
      }
      await command(id, args);
    },
    async jobs() { return (await ci()).jobs(); }, async detail(id) { return (await ci()).detail(id); },
    async workers() { return (await operator()).workers(); }, async cancel(id) { return (await operator()).cancel(id); },
    async retry(id, requestId) { return (await operator()).retry(id, requestId); }
  };
}
