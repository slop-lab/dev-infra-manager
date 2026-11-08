import { CommandFailure } from "../../web-lifecycle/process.ts";

export const incusPreparationLabels = ["incus-dependencies", "incus-initialize", "incus-forwarding", "incus-image-import",
  "incus-boot-agent", "incus-cloud-init", "incus-node", "incus-stop", "incus-publish", "incus-image-resolution",
  "incus-builder-delete", "incus-budget", "incus-forwarding-cleanup"] as const;
type Label = typeof incusPreparationLabels[number];

/** Fixture-owned timing only; presentation must never replace the operation's result. */
export async function timeIncusPreparation<T>(label: Label, operation: () => Promise<T>,
  write: (line: string) => void = line => { process.stderr.write(line); }): Promise<T> {
  const started = performance.now();
  const emit = (event: "start" | "finish", exitCode = 0): void => {
    try {
      const utc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      write(`[examples-timing] ${label} ${event} utc=${utc}${event === "finish"
        ? ` elapsedSeconds=${Math.ceil((performance.now() - started) / 1000)} exit=${exitCode}` : ""}\n`);
    } catch { /* Preserve success and the original failure even when the writer fails. */ }
  };
  emit("start");
  try { const result = await operation(); emit("finish"); return result; }
  catch (error) {
    const code = error instanceof CommandFailure ? error.result.exitCode : 1;
    emit("finish", Number.isSafeInteger(code) && code > 0 && code <= 255 ? code : 1);
    throw error;
  }
}
