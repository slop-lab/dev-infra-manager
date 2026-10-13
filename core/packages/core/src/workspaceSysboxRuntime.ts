import { UserError } from "./errors.js";
import type { StreamingCommandRunner } from "./types.js";

export async function assertWorkspaceSysboxRuntime(runner: StreamingCommandRunner): Promise<void> {
  const result = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (result.exitCode !== 0) {
    throw new UserError(`failed to inspect Docker runtimes for recommended workspace agent: ${result.stderr.trim()}`);
  }
  let runtimes: unknown;
  try {
    runtimes = JSON.parse(result.stdout);
  } catch (error) {
    throw new UserError("Docker runtime inspection returned invalid JSON", { cause: error });
  }
  if (typeof runtimes !== "object" || runtimes === null || Array.isArray(runtimes)
    || !Object.hasOwn(runtimes, "sysbox-runc")) {
    throw new UserError("Docker runtime 'sysbox-runc' is required for the recommended workspace agent; run 'dim doctor'");
  }
}
