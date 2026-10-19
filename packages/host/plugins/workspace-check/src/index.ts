import { randomUUID } from "node:crypto";
import { MissingRecordError, UserError, type WorkspaceHostPlugin, type WorkspaceHostPluginContext, type WorkspaceService } from "@slop-lab/dim-core/workspace";

type CheckOperations = Pick<WorkspaceService, "create" | "start" | "stop" | "recreate" | "discard" | "exec">;

export const hostPlugin: WorkspaceHostPlugin = {
  name: "workspace-check",
  commands: [{ name: "workspace-check", description: "Verify restart, recreation and persistent data using a disposable workspace" }],
  async run(args, context) {
    if (args[0] !== "workspace-check") throw new UserError("unsupported workspace-check command");
    const source = args[1];
    if (!source || source.startsWith("--")) throw new UserError("usage: dim workspace-check SOURCE [--image IMAGE] [--ref REF] [--runtime NAME]");
    let image: string | undefined, ref: string | undefined, runtime: string | undefined;
    for (let index = 2; index < args.length; index += 2) {
      const option = args[index], value = args[index + 1];
      if (!value) throw new UserError("workspace-check option requires a value");
      if (option === "--image" && image === undefined) image = value;
      else if (option === "--ref" && ref === undefined) ref = value;
      else if (option === "--runtime" && runtime === undefined) runtime = value;
      else throw new UserError(`unsupported or repeated workspace-check option '${option}'`);
    }
    const result = await checkWorkspace(context.service, { source, ...(image === undefined ? {} : { image }), ...(ref === undefined ? {} : { ref }), ...(runtime === undefined ? {} : { runtime }) }, context.cleanupWorkspace);
    console.log(JSON.stringify(result));
  }
};

/** Test orchestration belongs to this plugin; the runtime only supplies lifecycle operations. */
export async function checkWorkspace(service: CheckOperations, options: { source: string; image?: string; ref?: string; runtime?: string }, cleanup?: WorkspaceHostPluginContext["cleanupWorkspace"]) {
  const token = randomUUID(), name = `check-${token}`;
  const marker = `.dim-check-${token}`, volume = `dim-check-${token}`;
  const checks: string[] = [];
  let workspaceId: string | undefined;
  try {
    const created = await service.create({ name, source: { url: options.source, ...(options.ref === undefined ? {} : { ref: options.ref }) },
      ...(options.image === undefined ? {} : { image: options.image }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }) });
    workspaceId = created.id;
    const status = await service.exec(name, ["sh", "-c",
      `printf '%s' '${token}' > /workspace/${marker}; printf '%s' '${token}' > "$HOME/${marker}"; docker volume create '${volume}' >/dev/null`]);
    if (status !== 0) throw new UserError("workspace-check could not seed checkout, home and nested Docker state");
    for (const operation of ["restart", "recreate"] as const) {
      if (operation === "restart") { await service.stop(name); await service.start(name); }
      else await service.recreate(name);
      const verified = await service.exec(name, ["sh", "-c",
        `test "$(cat /workspace/${marker})" = '${token}' && test "$(cat "$HOME/${marker}")" = '${token}' && docker volume inspect '${volume}' >/dev/null`]);
      if (verified !== 0) throw new UserError(`workspace-check lost persistent data after ${operation}`);
      checks.push(operation);
    }
    return { workspace: name, checks, removed: true };
  } finally {
    // No user-selected workspace name is accepted, so cleanup cannot discard an existing workspace.
    try { if (cleanup) await cleanup(name, workspaceId); else await service.discard(name); }
    catch (error) { if (!(error instanceof MissingRecordError)) throw error; }
  }
}
