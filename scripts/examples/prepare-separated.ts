import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const directory = process.argv[2]; if (!directory?.startsWith("/")) throw new Error("absolute private operator directory required");
const { prepareControlPlane } = await import(pathToFileURL(resolve(import.meta.dirname, "../../packages/control-plane/admin/dist/controlPlaneSetup.js")).href) as typeof import("../../packages/control-plane/admin/src/controlPlaneSetup.js");
await prepareControlPlane({ directory, nativeGitImage: `example/native@sha256:${"a".repeat(64)}`, executionImage: `example/ci@sha256:${"b".repeat(64)}` });
const secret = () => randomBytes(32).toString("base64url");
await writeFile(join(directory, "acceptance-runtime.json"), JSON.stringify({ generationId: randomBytes(32).toString("hex"),
  native: { readinessToken: secret(), activationToken: secret() }, ci: { readinessToken: secret(), activationToken: secret() } }), { mode: 0o600, flag: "wx" });
console.log("Private configuration prepared for the separate control-plane VM");
