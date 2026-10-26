import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { deployGuestIntegration, workspaceServiceEndpoint } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { issuePrincipal, revokePrincipal } from "./client.js";
import { loadHostConfig, parseHostConfig } from "./config.js";
import { deployRouterHelpers } from "./integration.js";
import { createAttachment, createHostGateway } from "./gateway.js";
import { lockWorkspaceGateway, selectWorkspaceGateway, validateGatewayAdoption } from "./workspaceService.js";
import { snapshotRouterConnection, restoreRouterConnection } from "./connectionSnapshot.js";

const usage = `dim llm prepare DIRECTORY --control-plane ORIGIN --issuer ID --issuer-key-file FILE --endpoint GUEST_REACHABLE_ORIGIN [--listen-host IP] [--port PORT]
  dim llm serve|status CONFIG
  dim llm attach WORKSPACE --config CONFIG --project PROJECT [--route ID]`;
export async function runLlmCommand(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const [command, action, positional, ...tail] = args;
  if (command !== "llm" || !action || !positional || positional.startsWith("-")) throw new Error(usage);
  const flags = new Map<string, string>(), allowed = new Set(["--control-plane", "--issuer", "--issuer-key-file", "--endpoint", "--listen-host", "--port", "--config", "--project", "--route"]);
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
  const configFile = resolve(action === "attach" ? required("--config") : positional);
  const config = await loadHostConfig(configFile);
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
  const guard = await lockWorkspaceGateway(workspace, context);
  if (!guard) throw new Error("another LLM attachment is running for this workspace; retry after it finishes");
  try {
  const previousConnection = await snapshotRouterConnection(workspace, context);
  const issued = await issuePrincipal(config.connection, scope, context.signal);
  let attachment: Awaited<ReturnType<typeof createAttachment>> | undefined;
  let selected: Awaited<ReturnType<typeof selectWorkspaceGateway>> | undefined;
  let deliveryAttempted = false;
  try {
    attachment = await createAttachment(config, scope, issued);
    const connection = { schemaVersion: 1, workspaceId: workspace.id, projectId: scope.projectId, principalId: issued.principalId,
      endpoint: workspaceServiceEndpoint("llm-router"), token: attachment.token };
    selected = await selectWorkspaceGateway(workspace, context, configFile);
    await validateGatewayAdoption(config, workspace, previousConnection);
    await deployRouterHelpers(workspace, context);
    // Credentials are committed only after every public helper asset succeeds.
    deliveryAttempted = true;
    await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
      name: "llm-router-connection", files: [{ path: ".config/dim/llm-router.json", contents: JSON.stringify(connection), mode: 0o600 }]
    });
    const previous = await attachment.activate();
    selected = undefined;
    const cleanup = await Promise.allSettled(previous.map((old) => revokePrincipal(config.connection, old, AbortSignal.timeout(5000))));
    const failed = cleanup.filter((result) => result.status === "rejected").length;
    if (failed) console.warn(`Replaced attachment locally; ${failed} obsolete CP principal revocation(s) need operator cleanup.`);
  } catch (error) {
    const rollback = await Promise.allSettled([
      ...(selected === undefined ? [] : [selected.rollback()]),
      ...(!deliveryAttempted || attachment === undefined ? [] : [restoreRouterConnection({ workspace, context, previous: previousConnection, token: attachment.token })]),
      ...(attachment === undefined ? [] : [attachment.remove()]),
      revokePrincipal(config.connection, scope, AbortSignal.timeout(5000)),
    ]);
    const failures = rollback.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures], "LLM attachment failed and rollback was incomplete");
    throw error;
  }
  console.log(`Attached project '${scope.projectId}' route '${scope.routeId}' to ${workspace.name}; OpenCode and OMO keep their own model choices. Rerun dim tools server to refresh an existing server.`);
  } finally { await guard.release(); }
}
