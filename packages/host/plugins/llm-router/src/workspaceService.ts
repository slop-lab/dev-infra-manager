import { lstat, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { atomicWrite, tryAcquireKernelGuard } from "@slop-lab/dim-host-core";
import type { WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { loadHostConfig, object, privateFile, type HostRouterConfig } from "./config.js";

type WorkspaceGatewaySelection = {
  readonly schemaVersion: 1;
  readonly configFile: string;
  readonly gatewayStateDirectory: string;
  readonly workspaceStateRoot: string;
  readonly gatewayIdentity: string;
};

async function selectionDirectory(context: WorkspaceHostPluginContext): Promise<string> {
  const directory = join(context.stateRoot, "llm-services");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error("workspace LLM service selection directory must be private and owned");
  }
  return directory;
}

async function selectionFile(context: WorkspaceHostPluginContext, workspace: WorkspaceRecord): Promise<string> {
  return join(await selectionDirectory(context), `${workspace.id}.json`);
}

async function readSelection(file: string): Promise<WorkspaceGatewaySelection | undefined> {
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(await privateFile(file, 8192))); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (value.schemaVersion !== 1 || typeof value.configFile !== "string" || typeof value.gatewayStateDirectory !== "string"
    || typeof value.workspaceStateRoot !== "string" || typeof value.gatewayIdentity !== "string" || !/^[a-f0-9]{64}$/.test(value.gatewayIdentity)) throw new Error("invalid private workspace LLM service selection");
  return { schemaVersion: 1, configFile: value.configFile, gatewayStateDirectory: value.gatewayStateDirectory, workspaceStateRoot: value.workspaceStateRoot, gatewayIdentity: value.gatewayIdentity };
}

export async function lockWorkspaceGateway(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  return tryAcquireKernelGuard(join(await selectionDirectory(context), `${workspace.id}.guard`));
}

export async function validateGatewayAdoption(config: HostRouterConfig, workspace: WorkspaceRecord, previousConnection: string | undefined): Promise<void> {
  if (previousConnection === undefined) return;
  const connection = object(JSON.parse(previousConnection));
  if (typeof connection.token !== "string") throw new Error("invalid prior workspace LLM connection");
  const tokenHash = createHash("sha256").update(connection.token).digest("hex");
  const directory = join(config.stateDirectory, "attachments");
  const current = object(JSON.parse(await privateFile(join(directory, `.current-${workspace.id}.json`), 1024)));
  const grant = object(JSON.parse(await privateFile(join(directory, `${tokenHash}.json`), 16384)));
  if (current.tokenHash !== tokenHash || grant.workspaceId !== workspace.id || grant.workspaceName !== workspace.name) {
    throw new Error("prior LLM attachment belongs to another gateway or binding; retire it before reattaching");
  }
}

export async function selectWorkspaceGateway(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext, requestedConfigFile: string) {
  const file = await selectionFile(context, workspace);
  const previous = await readSelection(file);
  const configFile = resolve(requestedConfigFile);
  const config = await loadHostConfig(configFile);
  if (config.workspaceStateRoot !== context.store.root) throw new Error("workspace LLM service belongs to another state root");
  if (previous?.configFile !== undefined && previous.configFile !== configFile) {
    throw new Error("workspace is attached through another LLM gateway configuration; retire that attachment before reattaching");
  }
  const gatewayIdentity = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  if (previous !== undefined && previous.gatewayIdentity !== gatewayIdentity) {
    throw new Error("workspace LLM gateway identity changed; restore the selected gateway or retire the attachment before reattaching");
  }
  const selected: WorkspaceGatewaySelection = { schemaVersion: 1, configFile, gatewayStateDirectory: config.stateDirectory, workspaceStateRoot: config.workspaceStateRoot, gatewayIdentity };
  await atomicWrite(file, selected);
  return { async rollback(): Promise<void> {
    if (previous === undefined) {
      await unlink(file).catch((error: unknown) => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; });
    } else await atomicWrite(file, previous);
  } };
}

export const workspaceRouterServices = {
  names: ["llm-router"] as const,
  async resolve(name: string, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<string | undefined> {
    if (name !== "llm-router") return;
    const selected = await readSelection(await selectionFile(context, workspace));
    if (selected === undefined) return;
    const config = await loadHostConfig(selected.configFile);
    const workspaceStateRoot = selected.workspaceStateRoot;
    if (workspaceStateRoot !== context.store.root || config.workspaceStateRoot !== workspaceStateRoot) {
      throw new Error("workspace LLM service belongs to another state root");
    }
    if (createHash("sha256").update(JSON.stringify(config)).digest("hex") !== selected.gatewayIdentity) {
      throw new Error("workspace LLM gateway identity changed; reattach after retiring the previous gateway");
    }
    const host = config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host;
    return `http://${host.includes(":") ? `[${host}]` : host}:${config.listen.port}`;
  },
};
