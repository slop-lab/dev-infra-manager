import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createLlmRouterClient, privateOperatorFile } from "@slop-lab/dim-llm-router-client";
import { llmOperation, llmOperations } from "@slop-lab/dim-contracts-llm-router";

const selectionFile = (environment: NodeJS.ProcessEnv) => resolve(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dim/llm/operator-selection.json");
const defaultConnection = (environment: NodeJS.ProcessEnv) => resolve(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dim/llm/operator.json");
async function selectedConnection(environment: NodeJS.ProcessEnv): Promise<string> {
  if (environment.DIM_LLM_ROUTER_OPERATOR_CONNECTION_FILE !== undefined) {
    if (!isAbsolute(environment.DIM_LLM_ROUTER_OPERATOR_CONNECTION_FILE)) throw new Error("LLM router operator override requires an absolute path");
    return environment.DIM_LLM_ROUTER_OPERATOR_CONNECTION_FILE;
  }
  let serialized;
  try { serialized = await privateOperatorFile(selectionFile(environment)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConnection(environment); throw error; }
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "connectionFile,schemaVersion"
    || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("connectionFile" in value) || typeof value.connectionFile !== "string" || !isAbsolute(value.connectionFile)) throw new Error("invalid LLM router operator selection");
  return value.connectionFile;
}
export async function createControllerLlmRouterConsole(environment: NodeJS.ProcessEnv = process.env, expectedSelectionId?: string, signal?: AbortSignal) {
  if (expectedSelectionId !== undefined && !/^[a-f0-9]{64}$/.test(expectedSelectionId)) throw new Error("LLM router console requires a valid expected selection");
  const file = await selectedConnection(environment);
  const selectionId = await createLlmRouterClient(file).selectionId();
  if (expectedSelectionId !== undefined && expectedSelectionId !== selectionId) throw new Error("LLM router operator selection changed; reconnect before continuing");
  const client = createLlmRouterClient(file, { expectedSelectionId: selectionId, ...(signal === undefined ? {} : { signal }) });
  const capabilities = await client.capabilities();
  const operations = llmOperations.filter((operation) => capabilities.some(({ name, access }) => name === operation.name && access === operation.access));
  return { selectionId, operations: operations.map(({ name, description, access }) => ({ name, description, access })),
    async invoke(name: string, input: unknown) {
      if (!operations.some((operation) => operation.name === name)) throw new Error("LLM router operation is not available for this controller operator");
      return client.invoke(name, llmOperation(name).parseInput(input));
    }
  };
}
export async function connectControllerLlmRouter(connectionFile: string, environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
  if (!isAbsolute(connectionFile)) throw new Error("LLM router connection requires an absolute operator file");
  const client = createLlmRouterClient(connectionFile, signal === undefined ? {} : { signal });
  const selectionId = await client.selectionId();
  await createLlmRouterClient(connectionFile, { expectedSelectionId: selectionId, ...(signal === undefined ? {} : { signal }) }).capabilities();
  const file = selectionFile(environment), directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o022) !== 0) throw new Error("LLM router selection directory must be owned and non-writable by others");
  try { await privateOperatorFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const stage = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await stage.writeFile(`${JSON.stringify({ schemaVersion: 1, connectionFile })}\n`); await stage.sync(); } finally { await stage.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
  return { schemaVersion: 1, selectionId };
}
export async function runLlmRouterConsole(args: readonly string[], signal?: AbortSignal): Promise<void> {
  const [action, ...flags] = args;
  const operation = action === "invoke" ? flags.shift() : undefined;
  let expectedSelection: string | undefined, input: string | undefined, connection: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json") continue;
    const value = flags[index + 1];
    if (!value || value.startsWith("--")) throw new Error("LLM router console option requires a value");
    if (flag === "--expected-selection" && expectedSelection === undefined) expectedSelection = value;
    else if (flag === "--input" && input === undefined) input = value;
    else if (flag === "--connection" && connection === undefined) connection = value;
    else throw new Error("Invalid LLM router console option");
    index++;
  }
  if (action === "connect" && connection !== undefined && expectedSelection === undefined && input === undefined) {
    process.stdout.write(`${JSON.stringify(await connectControllerLlmRouter(connection, process.env, signal))}\n`); return;
  }
  if (connection !== undefined) throw new Error("LLM router console uses the controller's trusted operator selection; configure it with connect");
  if (action === "describe" && input === undefined) {
    const console = await createControllerLlmRouterConsole(process.env, expectedSelection, signal);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, selectionId: console.selectionId, operations: console.operations })}\n`); return;
  }
  if (action !== "invoke" || !operation || !expectedSelection || input === undefined || Buffer.byteLength(input) > 64 * 1024) throw new Error("usage: dim llm-router console describe --json | dim llm-router console invoke OP --expected-selection HASH --input JSON|- --json");
  let serialized = input;
  if (input === "-") {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.length;
      if (size > 64 * 1024) throw new Error("LLM router console input exceeds 64 KiB");
      chunks.push(bytes);
    }
    serialized = Buffer.concat(chunks).toString("utf8");
  }
  let payload: unknown;
  try { payload = JSON.parse(serialized) as unknown; } catch { throw new Error("LLM router console input must be valid JSON"); }
  process.stdout.write(`${JSON.stringify(await (await createControllerLlmRouterConsole(process.env, expectedSelection, signal)).invoke(operation, payload))}\n`);
}
