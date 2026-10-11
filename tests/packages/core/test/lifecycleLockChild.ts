import { createInterface } from "node:readline";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const root = process.argv[2];
const name = process.argv[3];
if (root === undefined || name === undefined) {
  throw new Error("lifecycle lock child requires a state root and workspace name");
}

const commandInput = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const commands = commandInput[Symbol.asyncIterator]();
const waitForCommand = async (expected: string): Promise<void> => {
  const command = await commands.next();
  if (command.done || command.value !== expected) {
    throw new Error(`lifecycle lock child expected '${expected}' command`);
  }
};

process.stdout.write("ready\n");
await waitForCommand("start");
process.stdout.write("started\n");
const release = await new LifecycleState(root, {
  waitTimeoutMs: 30_000,
  retryDelayMs: 1,
  sleep: async () => {
    process.stdout.write("contended\n");
    await waitForCommand("retry");
  }
}).acquireWorkspaceLock(name);
process.stdout.write("acquired\n");
await waitForCommand("release");
await release();
process.stdout.write("released\n");
commandInput.close();
