/** Trusted fixture controller; real SDK calls exercise actual Native Git APIs. */
import { readFile } from "node:fs/promises";
import { createNativeGitOperator, nativeGitProjectSchema } from "@slop-lab/dim-native-git-client";
const args = process.argv.slice(2), settingsFlag = args.indexOf("--fixture-settings"), settingsPath = args[settingsFlag + 1];
if (settingsFlag < 0 || !settingsPath || args[0] !== "--host" || args[1] !== "fixture") throw new Error("invalid fixture controller invocation");
const command = args.slice(2, settingsFlag).filter((arg) => arg !== "--json");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fixture settings");
  return value as Record<string, unknown>;
}
const raw = object(JSON.parse(await readFile(settingsPath, "utf8")));
if (typeof raw.reviewerConnection !== "string" || typeof raw.generationId !== "string" || !/^[a-f0-9]{64}$/.test(raw.generationId) || !Array.isArray(raw.projects)) throw new Error("invalid fixture controller settings");
const settings = { reviewerConnection: raw.reviewerConnection, generationId: raw.generationId, projects: raw.projects.map((project: unknown) => nativeGitProjectSchema.parse(project)) };
if (command[0] === "ls") { console.log("[]"); process.exit(0); }
if (command[0] !== "project" || command[1] !== "console") throw new Error("unsupported fixture controller command");
const expectedIndex = command.indexOf("--expected-generation"), expected = expectedIndex < 0 ? undefined : command[expectedIndex + 1];
if (expected !== undefined && expected !== settings.generationId || command[2] === "invoke" && !expected) throw new Error("controller generation changed");
const operator = await createNativeGitOperator({ reviewerConnection: settings.reviewerConnection, projects: async () => settings.projects });
if (command[2] === "describe") {
  const catalog = object(await operator.invoke("projects.list", {}));
  console.log(JSON.stringify({ schemaVersion: 1, generationId: settings.generationId, ...catalog,
    operations: operator.operations.map(({ name, description, access }) => ({ name, description, access })) }));
} else if (command[2] === "invoke") {
  const name = command[3], inputIndex = command.indexOf("--input");
  if (!name || inputIndex < 0 || !command[inputIndex + 1]) throw new Error("missing operation input");
  console.log(JSON.stringify(await operator.invoke(name, JSON.parse(command[inputIndex + 1]!) as unknown)));
} else throw new Error("unsupported fixture controller operation");
