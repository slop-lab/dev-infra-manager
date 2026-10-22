import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// Capture the loaded installation once. An old process must not advertise the
// identity of replacement files merely because the stable runtime path is reused.
const directory = statSync(new URL("./", import.meta.url), { bigint: true });
export const nativeWorkspaceBrokerRuntimeRevision = createHash("sha256")
  .update(`${directory.dev}:${directory.ino}`)
  .update(readFileSync(import.meta.url.endsWith(".ts") ? new URL("./nativeWorkspaceBroker.ts", import.meta.url) : new URL("./nativeWorkspaceBroker.js", import.meta.url)))
  .digest("hex");
