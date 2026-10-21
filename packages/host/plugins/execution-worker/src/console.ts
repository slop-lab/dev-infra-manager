import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { ciQueryConnectionSchema } from "@slop-lab/dim-contracts-ci/connections";
import { executionOperatorConnectionSchema } from "@slop-lab/dim-contracts-execution/connections";
import { createExecutionConsole } from "@slop-lab/dim-execution-client";
const absolutePath = z.string().refine(isAbsolute);
const selectionSchema = z.object({ schemaVersion: z.literal(1), hostConnectionFile: absolutePath, importerConnectionFile: absolutePath }).strict();
async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) throw new Error("Execution console selection and connections must be private regular files");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
}
export async function createHostExecutionConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string) {
  const selection = selectionSchema.parse(await privateJson(join(managedStateRoot(environment), "active-control-plane.json")));
  const directory = dirname(selection.hostConnectionFile);
  const queryConnection = join(directory, "ci-query.json"), operatorConnection = join(directory, "execution-operator.json");
  const query = ciQueryConnectionSchema.parse(await privateJson(queryConnection));
  const selected = z.object({ schemaVersion: z.literal(1), nativeGit: z.object({ generationId: z.string().regex(/^[a-f0-9]{64}$/) }) }).parse(await privateJson(selection.hostConnectionFile));
  if (query.generationId !== selected.nativeGit.generationId) throw new Error("Execution connection does not match the selected control-plane generation");
  if (expectedGeneration !== undefined && expectedGeneration !== query.generationId) throw new Error("Selected execution control-plane generation changed; reconnect before continuing");
  let operatorFile: string | undefined;
  try {
    const operator = executionOperatorConnectionSchema.parse(await privateJson(operatorConnection));
    if (operator.endpoint !== query.endpoint || operator.generationId !== query.generationId || operator.credential.username === query.credential.username || operator.credential.password === query.credential.password) throw new Error("Execution query and operator connections must select the same service with distinct credentials");
    operatorFile = operatorConnection;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const console = await createExecutionConsole({ queryConnection, ...(operatorFile ? { operatorConnection: operatorFile } : {}) });
  // Attest credentials against their own role endpoints before publishing capabilities.
  await console.invoke("jobs.list", {});
  if (operatorFile) await console.invoke("workers.list", {});
  return { ...console, generationId: query.generationId };
}
export async function describeHostExecutionConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string) {
  const console = await createHostExecutionConsole(environment, expectedGeneration);
  return { schemaVersion: 1, generationId: console.generationId, operations: operationDescriptors(console.operations) };
}
export async function invokeHostExecutionConsole(name: string, input: unknown, expectedGeneration: string, environment: NodeJS.ProcessEnv = process.env) {
  if (!/^[a-f0-9]{64}$/.test(expectedGeneration)) throw new Error("Execution console requires an expected generation");
  return (await createHostExecutionConsole(environment, expectedGeneration)).invoke(name, input);
}
export async function runExecutionConsole(args: string[]): Promise<void> {
  const [action, ...flags] = args;
  let generation: string | undefined, input: string | undefined;
  let operation: string | undefined;
  if (action === "invoke") operation = flags.shift();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json") continue;
    if (flag === "--expected-generation" && generation === undefined) generation = flags[++index];
    else if (flag === "--input" && input === undefined) input = flags[++index];
    else throw new Error("Invalid execution console option");
  }
  if (action === "describe") { if (input !== undefined) throw new Error("Execution console describe does not accept input"); process.stdout.write(`${JSON.stringify(await describeHostExecutionConsole(process.env, generation))}\n`); return; }
  if (action !== "invoke" || !operation || !generation || input === undefined || Buffer.byteLength(input) > 64 * 1024) throw new Error("usage: dim execution console describe --json | dim execution console invoke OPERATION --expected-generation HASH --input JSON --json");
  process.stdout.write(`${JSON.stringify(await invokeHostExecutionConsole(operation, JSON.parse(input) as unknown, generation))}\n`);
}
