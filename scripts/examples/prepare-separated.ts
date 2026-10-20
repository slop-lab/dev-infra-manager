import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const directory = process.argv[2]; if (!directory?.startsWith("/")) throw new Error("absolute private operator directory required");
const { prepareControlPlane } = await import(pathToFileURL(resolve(import.meta.dirname, "../../packages/control-plane/admin/dist/controlPlaneSetup.js")).href) as typeof import("../../packages/control-plane/admin/src/controlPlaneSetup.js");
await prepareControlPlane({ directory, nativeGitImage: `example/native@sha256:${"a".repeat(64)}`, ordinaryCiImage: `example/ci@sha256:${"b".repeat(64)}` });
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid generated service config"); return Object.fromEntries(Object.entries(value)); }
const native = object(JSON.parse(await readFile(join(directory, "native-git.json"), "utf8")));
const ci = object(native.ci); native.ci = { ...ci, webhook: { ...object(ci.webhook), endpoint: "http://127.0.0.1:8081/v1/jobs" } };
const ordinary = object(JSON.parse(await readFile(join(directory, "ordinary-ci.json"), "utf8")));
ordinary.nativeGit = { ...object(ordinary.nativeGit), endpoint: "http://127.0.0.1:8080" };
await writeFile(join(directory, "native-git.json"), JSON.stringify(native), { mode: 0o600 });
await writeFile(join(directory, "ordinary-ci.json"), JSON.stringify(ordinary), { mode: 0o600 });
const secret = () => randomBytes(32).toString("base64url");
await writeFile(join(directory, "acceptance-runtime.json"), JSON.stringify({ generationId: randomBytes(32).toString("hex"),
  native: { readinessToken: secret(), activationToken: secret() }, ci: { readinessToken: secret(), activationToken: secret() } }), { mode: 0o600, flag: "wx" });
console.log("Private configuration prepared for the separate control-plane VM");
