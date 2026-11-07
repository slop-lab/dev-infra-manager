import { CommandFailure, runCommand } from "../../web-lifecycle/process.ts";

/** Reconnect only the owned VM's read-only status stream, never a lifecycle operation. */
export async function waitForIncusCloudInit(deadline: number, operations: {
  run?: typeof runCommand;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  report?: (message: string) => void;
} = {}): Promise<void> {
  const run = operations.run ?? runCommand, now = operations.now ?? Date.now;
  const pause = operations.pause ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const report = operations.report ?? ((message) => console.error(message));
  const args = ["incus", "--force-local", "--project", "practical-ci", "exec", "practical-ci-image-builder", "--", "cloud-init", "status", "--wait"];
  let attempt = 0;
  for (;;) {
    const remaining = Math.ceil(deadline - now());
    if (remaining <= 0) throw new Error("pinned CI VM cloud-init readiness deadline expired");
    attempt++;
    const result = await run("sudo", args, { acceptFailure: true, timeoutMs: remaining });
    if (now() >= deadline) throw new Error("pinned CI VM cloud-init readiness deadline expired");
    if (result.exitCode === 0) return;
    if (result.exitCode !== 255 || !/^(?:Error: )?local error: tls: bad record MAC$/.test(result.stderr.trim())) throw new CommandFailure("sudo", args, result);
    report(`[practical-ci] cloud-init status attempt=${attempt} transport=tls-bad-record-mac; reconnecting read-only status`);
    await pause(Math.min(1000, Math.max(0, deadline - now())));
  }
}
