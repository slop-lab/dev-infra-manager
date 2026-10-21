/** Fixed trusted fixture bridge into production host management and acquisition. */
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createNativeProjectConsole } from "../../../packages/host/plugins/native-git/src/projectConsole.js";
import { preparePublicGitSource } from "../../../packages/host/plugins/native-git/src/public-git-source.js";
const args = process.argv.slice(2), settingsIndex = args.indexOf("--fixture-settings"), settingsPath = args[settingsIndex + 1];
if (!settingsPath || settingsIndex < 0 || args[0] !== "--host" || args[1] !== "fixture") throw new Error("invalid fixture controller invocation");
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fixture settings"); return value as Record<string, unknown>; }
const raw = object(JSON.parse(await readFile(settingsPath, "utf8")));
for (const name of ["state", "hostFile", "importerFile", "gitOrigin"]) if (typeof raw[name] !== "string") throw new Error("invalid fixture settings");
const state = String(raw.state), hostFile = String(raw.hostFile), importerFile = String(raw.importerFile), origin = new URL(String(raw.gitOrigin));
const env = { ...process.env, DIM_MANAGED_STATE_ROOT: state, DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: hostFile, DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: importerFile };
const command = args.slice(2, settingsIndex).filter((arg) => arg !== "--json");
if (command[0] === "ls") { console.log("[]"); process.exit(0); }
if (command[0] !== "project" || command[1] !== "console") throw new Error("unsupported fixture command");
const expectedIndex = command.indexOf("--expected-generation"), expected = expectedIndex < 0 ? undefined : command[expectedIndex + 1];
const operator = await createNativeProjectConsole(env, expected, {
  prepareSource(input) {
    return preparePublicGitSource(input, {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      request(options, callback) {
        const path = String(options.path), project = path.startsWith("/mjy9088/codyssey-public.git/") ? "project-a" : path.startsWith("/mjy9088/codyssey-private.git/") ? "project-b" : undefined;
        const suffix = path.slice(path.indexOf(".git/") + 4);
        return request({ hostname: origin.hostname, port: origin.port, path: project ? `/v1/projects/${project}/repositories/source.git${suffix}` : "/missing", method: options.method, headers: options.headers, signal: options.signal }, callback);
      }
    });
  }
});
if (command[2] === "describe") {
  const catalog = object(await operator.invoke("projects.list", {}));
  console.log(JSON.stringify({ schemaVersion: 1, generationId: operator.generationId, ...catalog, operations: operator.operations.map(({ name, description, access }) => ({ name, description, access })) }));
} else if (command[2] === "invoke") {
  const name = command[3], inputIndex = command.indexOf("--input");
  if (!name || inputIndex < 0 || !command[inputIndex + 1] || !expected) throw new Error("missing operation input or generation");
  console.log(JSON.stringify(await operator.invoke(name, JSON.parse(command[inputIndex + 1]!) as unknown)));
} else throw new Error("unsupported fixture operation");
