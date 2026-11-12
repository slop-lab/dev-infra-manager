import { Writable } from "node:stream";
import { UserError } from "../errors.js";
import type { WorkspaceRecord } from "../workspace/models.js";
import type { WorkspaceService } from "../workspace/service.js";

const probe = `
const { readFile } = require("node:fs/promises");
const { writeSync } = require("node:fs");
const fail = (code) => { process.stdout.write("boot-identity:" + code); process.exitCode = 1; };
const timer = setTimeout(() => { writeSync(1, "boot-identity:TIMEOUT"); process.exit(1); }, 4000);
readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.trim())) process.stdout.write("boot-identity:ready");
  else fail("INVALID_BOOT_ID");
}, (error) => fail(typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "READ_FAILED"))
.finally(() => clearTimeout(timer));
`;

export async function verifyWorkspaceBootIdentity(workspace: WorkspaceRecord, context: {
  readonly service: Pick<WorkspaceService, "exec">;
  readonly signal: AbortSignal;
}): Promise<void> {
  let output = "";
  let errors = "";
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString("utf8").slice(0, Math.max(0, 128 - output.length)); done(); } });
  const stderr = new Writable({ write(chunk: Buffer, _encoding, done) { errors += chunk.toString("utf8").slice(0, Math.max(0, 1024 - errors.length)); done(); } });
  const deadline = AbortSignal.timeout(5_000);
  let detail: string;
  try {
    const status = await context.service.exec(workspace.name, ["node", "--input-type=commonjs", "-e", probe], {
      workspaceId: workspace.id, signal: AbortSignal.any([context.signal, deadline]), stdout, stderr
    });
    context.signal.throwIfAborted();
    if (deadline.aborted) detail = "TIMEOUT";
    else {
      if (status === 0 && output === "boot-identity:ready") return;
      detail = /^boot-identity:[A-Z0-9_]+$/.test(output) ? output.slice("boot-identity:".length) : `probe exited ${status}: ${errors.trim()}`;
    }
  } catch (error) {
    context.signal.throwIfAborted();
    if (!deadline.aborted) throw error;
    detail = "TIMEOUT";
  }
  throw new UserError(`workspace '${workspace.name}' (UUID ${workspace.id}) runtime boot identity /proc/sys/kernel/random/boot_id is unavailable (${detail}); integration preparation was not attempted. This is not evidence of a cache URL or LLM routing failure. No processes were stopped or data changed. Have the operator inspect this exact UUID and confirm all main sessions, subagents and teams are quiescent before an explicit keep-data recreate; unknown activity is not idle. See docs/guides/workspace-runtime-recovery.md`);
}
