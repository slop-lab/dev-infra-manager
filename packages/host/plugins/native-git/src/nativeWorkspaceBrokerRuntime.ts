import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

// Capture the loaded installation once. An old process must not advertise the
// identity of replacement files merely because the stable runtime path is reused.
// Installed manifests pin the complete reviewed package/dependency release. Include
// them so an in-place upgrade also invalidates brokers when only an imported
// client changes. Source execution retains its source-file identity fallback.
const manifest = new URL("./package.json", import.meta.url);
const packageManifest = existsSync(manifest) ? manifest : new URL("../package.json", import.meta.url);
const directory = statSync(new URL("./", import.meta.url), { bigint: true });
export const nativeWorkspaceBrokerRuntimeRevision = createHash("sha256")
  .update(`${directory.dev}:${directory.ino}`)
  .update(readFileSync(packageManifest))
  .update(readFileSync(import.meta.url.endsWith(".ts") ? new URL("./nativeWorkspaceBroker.ts", import.meta.url) : new URL("./nativeWorkspaceBroker.js", import.meta.url)))
  .digest("hex");
