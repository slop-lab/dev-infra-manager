import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runHostExecutionCapacity } from "../../../../packages/host/plugins/execution-worker/src/capacity.js";
const root = process.argv[2]; if (!root) throw new Error("fixture root required");
const stop = new AbortController(); process.once("SIGTERM", () => stop.abort());
await runHostExecutionCapacity(join(root, "capacity.json"), stop.signal, { taskHandlers: [{ taskType: "capacity-proof", revision: "b".repeat(64),
  async run() {
    await writeFile(join(root, "task-started"), "started", { mode: 0o600 });
    for (;;) { try { await access(join(root, "release-task")); return { realHostWorker: true }; } catch { await delay(20); } }
  }, async cleanup() { return true; } }] });
process.stdout.write("capacity-drained\n");
