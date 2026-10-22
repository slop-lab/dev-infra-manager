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
    if (!value.includes("://") && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[^:\s\x00-\x1f\x7f][^\s\x00-\x1f\x7f]*$/.test(value)) return true;
    try { const url = new URL(value); return ["https:", "http:", "ssh:"].includes(url.protocol) && Boolean(url.hostname) && !url.hash && !url.search
      && !url.password && (url.protocol === "ssh:" || !url.username); }
    catch { return false; }
  }, "use an HTTP(S) or SSH repository without embedded credentials, or dim://PROJECT"),
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
  initialized: z.boolean().optional(),
  resources: z.object({ cpuCount: z.string(), memory: z.string(), pidsLimit: z.string() }).strict() });
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export interface WebOperations {
  hosts(): Promise<unknown>;
  workspaces(host: string): Promise<unknown>;
  workspaceAction(host: string, input: WorkspaceAction): Promise<void>;
  workspaceCreate(host: string, input: WorkspaceCreate): Promise<void>;

}
const execute = promisify(execFile);
/** Host stderr can contain repository credentials and private paths. Only fixed
 * categories cross the operator Web boundary, never the matched diagnostic. */
function hostFailure(error: unknown): HttpResponseError {
  const value = error !== null && typeof error === "object" ? error : {};
  const code = "code" in value ? value.code : undefined;
  const diagnostic = "stderr" in value && typeof value.stderr === "string" ? value.stderr.slice(0, 2 * 1024 * 1024) : "";
  if (code === "ENOENT") return new HttpResponseError(503, "The configured DIM executable is unavailable on the Web server. Ask the operator to repair the host connection.", "host_unavailable");
  if ("killed" in value && value.killed === true) return new HttpResponseError(504, "The host operation timed out. Refresh the host before retrying; it may still have created workspace data.", "host_timeout");
  if (/workspace '[a-z0-9._-]+' already exists/i.test(diagnostic)) return new HttpResponseError(409, "A workspace with this name already exists. Refresh the host and choose another name, or recover the existing workspace.", "workspace_exists");
  if (/pull access denied|manifest unknown|no such image|unable to find image|repository does not exist.*docker login/i.test(diagnostic)) return new HttpResponseError(409, "The workspace image is unavailable on the selected host. Choose an installed image, or ask the operator to build or pull the host default image.", "image_unavailable");
  if (/cannot connect to the docker daemon|docker daemon is not running|permission denied.*docker.sock|runtime '[a-z0-9-]+' (?:is )?(?:not installed|not found|unavailable)|kvm.*(?:unavailable|permission denied|not found)/i.test(diagnostic)) return new HttpResponseError(503, "The selected host runtime is unavailable. Ask the operator to run dim doctor on that host and repair its runtime prerequisites.", "runtime_unavailable");
  if (/project '[a-z0-9-]+' not found|managed project.*not found|unknown project/i.test(diagnostic)) return new HttpResponseError(409, "The managed project was not found on this host. Check the managed project connection, or use an ordinary Git repository URL.", "project_unavailable");
  if (/couldn't find remote ref|remote branch .* not found|could not find.*ref|unknown revision/i.test(diagnostic)) return new HttpResponseError(409, "The requested Git ref was not found. Leave Git ref empty to use the repository default, or enter an existing branch or commit.", "ref_unavailable");
  if (/authentication failed|could not read username|permission denied \(publickey\)|repository not found/i.test(diagnostic)) return new HttpResponseError(409, "The selected host could not access the repository. Check the URL and host Git credentials, or use another accessible repository.", "repository_unavailable");
  return new HttpResponseError(409, "The host operation failed. Refresh the host before retrying and ask the operator to inspect it with dim doctor.", "host_operation_failed");
}
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
    } catch (error) { throw hostFailure(error); }
  }
  return {
    async hosts() { return config.hosts.map(({ id }) => ({ id })); },
    async workspaces(id) {
      const rows = z.array(workspaceSummarySchema.extend({ error: z.string().optional() })).max(1024).parse(await command(id, ["ls"]));
      return rows.map(({ error, ...row }) => ({ ...row, ...(row.phase === "error" && error ? { failureCode: hostFailure({ stderr: error }).code } : {}) }));
    },
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
