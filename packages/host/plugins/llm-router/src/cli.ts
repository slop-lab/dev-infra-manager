import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { deployGuestIntegration } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { issuePrincipal, revokePrincipal } from "./client.js";
import { loadHostConfig, parseHostConfig } from "./config.js";
import { deployRouterHelpers } from "./integration.js";
import { createAttachment, createHostGateway, lockWorkspaceAttachment } from "./gateway.js";

const usage = `dim llm prepare DIRECTORY --control-plane ORIGIN --issuer ID --issuer-key-file FILE --endpoint GUEST_REACHABLE_ORIGIN [--listen-host IP] [--port PORT]
  dim llm serve|status CONFIG
  dim llm attach WORKSPACE --config CONFIG --project PROJECT [--route ID] [--model ID]`;
export async function runLlmCommand(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const [command, action, positional, ...tail] = args;
  if (command !== "llm" || !action || !positional || positional.startsWith("-")) throw new Error(usage);
  const flags = new Map<string, string>(), allowed = new Set(["--control-plane", "--issuer", "--issuer-key-file", "--endpoint", "--listen-host", "--port", "--config", "--project", "--route", "--model"]);
  for (let index = 0; index < tail.length; index += 2) {
    const name = tail[index], value = tail[index + 1];
    if (!name || !allowed.has(name) || !value || flags.has(name)) throw new Error(usage); flags.set(name, value);
  }
  const required = (name: string) => { const value = flags.get(name); if (!value) throw new Error(`required ${name}\n${usage}`); return value; };
  if (action === "prepare") {
    const directory = resolve(positional), config = parseHostConfig({ schemaVersion: 1, stateDirectory: join(directory, "state"), workspaceStateRoot: context.store.root,
      connection: { schemaVersion: 1, endpoint: required("--control-plane"), issuerId: required("--issuer"), issuerKeyFile: resolve(required("--issuer-key-file")) },
      listen: { host: flags.get("--listen-host") ?? "127.0.0.1", port: Number(flags.get("--port") ?? 8319) }, publicEndpoint: required("--endpoint") });
    await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, "gateway.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Prepared ${join(directory, "gateway.json")}. Run its persistent gateway before attaching workspaces.`); return;
  }
  const config = await loadHostConfig(resolve(action === "attach" ? required("--config") : positional));
  if (config.workspaceStateRoot !== context.store.root) throw new Error("gateway and selected host must use the same workspace state root");
  if (action === "status") { console.log(JSON.stringify({ controlPlane: config.connection.endpoint, gateway: config.publicEndpoint, workspaceStateRoot: config.workspaceStateRoot })); return; }
  if (action === "serve") {
    const gateway = await createHostGateway(config, context.store);
    try { context.signal.throwIfAborted(); gateway.server.listen(config.listen); await once(gateway.server, "listening", { signal: context.signal });
      console.log("Host LLM gateway listening; workspace liveness remains host-owned");
      await new Promise<void>((resolve) => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); });
    } finally { await gateway.close(); } return;
  }
  if (action !== "attach") throw new Error(usage);
  const workspace = await context.store.read(positional);
  if (!workspace.initialized || workspace.phase !== "running") throw new Error("LLM attachment requires a running initialized workspace");
  const scope = { bindingId: randomUUID(), workspaceId: workspace.id, workspaceName: workspace.name, projectId: required("--project"), routeId: flags.get("--route") ?? "default" };
  const guard = await lockWorkspaceAttachment(config, workspace.id);
  if (!guard) throw new Error("another LLM attachment is running for this workspace; retry after it finishes");
  try {
  const issued = await issuePrincipal(config.connection, scope, context.signal);
  const selectedModel = issued.models.find(({ id }) => id === (flags.get("--model") ?? issued.models[0]?.id));
  if (!selectedModel) { await revokePrincipal(config.connection, scope, context.signal); throw new Error("attachment default model must belong to the selected route"); }
  let attachment: Awaited<ReturnType<typeof createAttachment>> | undefined;
  try {
    attachment = await createAttachment(config, scope, issued);
    const connection = { schemaVersion: 1, workspaceId: workspace.id, projectId: scope.projectId, principalId: issued.principalId,
      endpoint: config.publicEndpoint, token: attachment.token, models: issued.models, defaultModel: selectedModel.id };
    await deployRouterHelpers(workspace, context);
    // Credentials are committed only after every public helper asset succeeds.
    await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
      name: "llm-router-connection", files: [{ path: ".config/dim/llm-router.json", contents: JSON.stringify(connection), mode: 0o600 }]
    });
    const previous = await attachment.activate();
    const cleanup = await Promise.allSettled(previous.map((old) => revokePrincipal(config.connection, old, AbortSignal.timeout(5000))));
    const failed = cleanup.filter((result) => result.status === "rejected").length;
    if (failed) console.warn(`Replaced attachment locally; ${failed} obsolete CP principal revocation(s) need operator cleanup.`);
  } catch (error) {
    await attachment?.remove();
    await revokePrincipal(config.connection, scope, AbortSignal.timeout(5000)); throw error;
  }
  const provider = selectedModel.api === "responses" ? "openai" : "dim-chat";
  console.log(`Attached project '${scope.projectId}' route '${scope.routeId}' to ${workspace.name}; unset OpenCode models default to ${provider}/${selectedModel.id}. OMO role choices are preserved. Rerun dim tools server to refresh an existing server.`);
  } finally { await guard.release(); }
}
