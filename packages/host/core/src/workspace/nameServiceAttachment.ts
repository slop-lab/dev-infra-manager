import { readFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "../errors.js";
import { acquireLifecycleLock } from "../lifecycleLock.js";
import { atomicWrite } from "../lifecycleRecord.js";
import { deployGuestIntegration } from "./guestIntegration.js";
import type { WorkspaceRecord } from "./models.js";
import type { WorkspaceService } from "./service.js";
import { flattenNameTable, parseNameTable, reconcileNameTable, type WorkspaceNameTable } from "./nameTable.js";
import type { WorkspaceNameRegistration } from "./nameRegistration.js";

/** Only SPAWN/DELIVER/CONFIGURE happens here: the host controller runs unprivileged and never binds a port.
 * All listening happens guest-side, under the `dim` user's NOPASSWD sudo, via nameServiceGuestMain.ts. */
const SERVICE_NAME = "dim-name-service";
// Fixed by the workspace image (workspace-image-assets/Dockerfile ENV HOME); not discovered per-workspace.
const GUEST_HOME = "/home/dim";
const GUEST_ROOT = `${GUEST_HOME}/.local/state/dim/name-service`;
const GUEST_MAIN = `${GUEST_ROOT}/workspace/nameServiceGuestMain.js`;
const GUEST_CONFIG = `${GUEST_ROOT}/config.json`;

export interface WorkspaceNameServiceContext {
  readonly stateRoot: string;
  readonly signal: AbortSignal;
  readonly service: Pick<WorkspaceService, "exec">;
}

function tableFile(stateRoot: string, workspace: WorkspaceRecord): string { return path.join(stateRoot, "names", `${workspace.id}.json`); }

async function readPersistedTable(stateRoot: string, workspace: WorkspaceRecord): Promise<WorkspaceNameTable> {
  try { return parseNameTable(JSON.parse(await readFile(tableFile(stateRoot, workspace), "utf8"))); }
  catch (error) { if (hasCode(error, "ENOENT")) return {}; throw error; }
}

// Guest payloads must be the compiled, dependency-free JS siblings of this module, never raw source.
// The published package is flattened (siblings sit beside this file), and so is the monorepo dist
// tree; only under tsx does this module run from `src/*.ts`, whose compiled siblings live in the
// parallel `dist/` tree, so anchor off this module's own compiled URL in that one case.
const compiledSelf = import.meta.url.endsWith(".ts") ? import.meta.url.replace("/src/", "/dist/").replace(/\.ts$/, ".js") : import.meta.url;
/** Reads a compiled sibling as text; shipped to the guest verbatim, never re-transpiled. */
async function moduleSource(relative: string): Promise<string> { return readFile(new URL(relative, compiledSelf), "utf8"); }

async function deliverGuestFiles(workspace: WorkspaceRecord, context: WorkspaceNameServiceContext, table: WorkspaceNameTable): Promise<void> {
  const [errorsSource, registrationSource, tableSource, resolverSource, ingressSource, mainSource] = await Promise.all([
    moduleSource("../errors.js"), moduleSource("./nameRegistration.js"), moduleSource("./nameTable.js"),
    moduleSource("./nameResolver.js"), moduleSource("./nameIngress.js"), moduleSource("./nameServiceGuestMain.js")
  ]);
  await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
    name: "name-service",
    files: [
      { path: ".local/state/dim/name-service/package.json", contents: JSON.stringify({ type: "module" }) },
      { path: ".local/state/dim/name-service/errors.js", contents: errorsSource },
      { path: ".local/state/dim/name-service/workspace/nameRegistration.js", contents: registrationSource },
      { path: ".local/state/dim/name-service/workspace/nameTable.js", contents: tableSource },
      { path: ".local/state/dim/name-service/workspace/nameResolver.js", contents: resolverSource },
      { path: ".local/state/dim/name-service/workspace/nameIngress.js", contents: ingressSource },
      { path: ".local/state/dim/name-service/workspace/nameServiceGuestMain.js", contents: mainSource },
      { path: ".local/state/dim/name-service/config.json", contents: JSON.stringify(table) }
    ]
  });
}

/** Idempotent: `register` is a no-op when argv is unchanged (it always is - only config.json's content changes),
 * and `resume`/`remove` are no-ops when the service is already in the requested state. */
async function applyGuestService(workspace: WorkspaceRecord, context: WorkspaceNameServiceContext, table: WorkspaceNameTable): Promise<void> {
  if (flattenNameTable(table).size === 0) {
    const removed = await context.service.exec(workspace.name, ["dim-workspace", "service", "remove", SERVICE_NAME], { workspaceId: workspace.id, signal: context.signal });
    if (removed !== 0) throw new UserError(`cannot remove the workspace name service (exit ${removed})`);
    return;
  }
  await deliverGuestFiles(workspace, context, table);
  const registered = await context.service.exec(workspace.name,
    ["dim-workspace", "service", "register", "--name", SERVICE_NAME, "--", "sudo", "-n", "node", GUEST_MAIN, GUEST_CONFIG],
    { workspaceId: workspace.id, signal: context.signal });
  if (registered !== 0) throw new UserError(`cannot register the workspace name service (exit ${registered})`);
  const resumed = await context.service.exec(workspace.name, ["dim-workspace", "service", "resume", SERVICE_NAME], { workspaceId: workspace.id, signal: context.signal });
  if (resumed !== 0) throw new UserError(`cannot start the workspace name service (exit ${resumed})`);
}

/** Replaces `owner`'s complete set of names for this workspace, (re)publishes the merged table, and delivers it guest-side. */
export async function reconcileWorkspaceNames(owner: string, workspace: WorkspaceRecord, registrations: readonly WorkspaceNameRegistration[], context: WorkspaceNameServiceContext): Promise<{ readonly resolver: string }> {
  if (!workspace.initialized || workspace.phase !== "running") throw new UserError(`workspace '${workspace.name}' must be running before registering internal names`);
  const file = tableFile(context.stateRoot, workspace);
  const release = await acquireLifecycleLock({ root: path.dirname(file), name: "names", description: "workspace name registration", options: { signal: context.signal } });
  try {
    // The lock spans delivery too: two concurrent owners' reconciles must never let an earlier
    // snapshot's guest delivery land after a later one's and silently undo it.
    const table = reconcileNameTable(await readPersistedTable(context.stateRoot, workspace), owner, registrations);
    await atomicWrite(file, table);
    await applyGuestService(workspace, context, table);
    // The guest's own resolver always answers registered names at its own loopback; nested-container
    // reachability is executionRouting's job (Phase 2), which can discover this address from here.
    return { resolver: "127.0.0.1" };
  } finally { await release(); }
}

/** Core knows the caller at this binding site; the returned handle carries no owner parameter a guest could spoof. */
export function bindNameServiceForOwner(owner: string, context: WorkspaceNameServiceContext): {
  reconcile(workspace: WorkspaceRecord, registrations: readonly WorkspaceNameRegistration[]): Promise<{ readonly resolver: string }>;
} {
  return { reconcile: (workspace, registrations) => reconcileWorkspaceNames(owner, workspace, registrations, context) };
}

function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code; }
