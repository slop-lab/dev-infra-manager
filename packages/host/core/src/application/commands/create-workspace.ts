import { UserError, parseWorkspaceRecord, type WorkspaceRecord } from "../../workspace.js";
interface HostTarget { readonly name: string }
import { runRecordOperation } from "./operations.js";
import type { HostOperationRequest as HostRequest } from "../host-application.js";
import { pluginSpecs, type RequiredPlugins } from "../workspace-plugin-specs.js";

export interface CreateWorkspaceOptions {
  readonly signal?: AbortSignal;
  /** Only an interactive operator may supply approval. Non-TTY clients omit this callback. */
  readonly approve?: (required: RequiredPlugins, host: HostTarget) => Promise<boolean>;
  readonly request?: (target: HostTarget, request: HostRequest, signal?: AbortSignal) => Promise<unknown>;
}

export async function createWorkspaceWithPlugins(target: HostTarget, input: Record<string, unknown>, options: CreateWorkspaceOptions = {}): Promise<WorkspaceRecord> {
  const request = options.request ?? ((_host, message, signal) => runRecordOperation(message, signal ? { signal } : {}));
  const result = await request(target, { operation: "create", input }, options.signal);
  const required = requiredPlugins(result);
  if (!required) return workspaceRecord(result);
  if (!options.approve) throw new UserError(`Host '${target.name}' needs plugins for ${required.source.url} at ${required.source.commit}: ${required.plugins.join(", ")}. Install on that host with 'mise exec -- dim installer install plugin ${required.plugins.join(" ")}', then retry create. Interactive approval requires a TTY.`);
  if (!await options.approve(required, target)) throw new UserError("required plugin installation declined; no workspace was created");
  await request(target, { operation: "plugins.installRequired", input: { plugins: required.plugins } }, options.signal);
  const retried = await request(target, { operation: "create", input: { ...input, expectedSourceCommit: required.source.commit } }, options.signal);
  if (requiredPlugins(retried)) throw new UserError("required plugins are still missing after installation; no workspace was created");
  return workspaceRecord(retried);
}

function requiredPlugins(value: unknown): RequiredPlugins | undefined {
  if (!object(value) || value.status !== "requires-plugins") return undefined;
  if (!object(value.source) || typeof value.source.url !== "string" || typeof value.source.ref !== "string"
    || typeof value.source.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.source.commit)) throw new UserError("invalid required-plugin host response");
  const plugins = pluginSpecs(value.plugins);
  if (!plugins.length) throw new UserError("invalid empty required-plugin host response");
  return { status: "requires-plugins", source: { url: value.source.url, ref: value.source.ref, commit: value.source.commit }, plugins };
}
function workspaceRecord(value: unknown): WorkspaceRecord {
  return parseWorkspaceRecord(value);
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
