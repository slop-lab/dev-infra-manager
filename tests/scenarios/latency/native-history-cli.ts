import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureNativeHistory } from "./native-history-measure.js";
import { prepareNativeHistoryCorpus, readNativeHistoryCorpus } from "./native-history-corpus.js";

const defaultSourceTree = fileURLToPath(new URL("../../../", import.meta.url));

class NativeHistoryCliError extends Error {
  readonly name = "NativeHistoryCliError";
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "--help" || command === "-h") {
    process.stdout.write("Usage: native-history-cli.ts <prepare|measure|measure-intents> SOURCE_TREE CORPUS_DIRECTORY\nSynthetic history only; measure-intents adds 10000 retained completed intents. Measurements retain canonical corpus and remove fixture transient delivery state.\n");
    return;
  }
  const sourceTree = resolve(process.argv[3] ?? defaultSourceTree);
  const corpusDirectory = process.argv[4];
  if ((command !== "prepare" && command !== "measure" && command !== "measure-intents") || corpusDirectory === undefined) {
    throw new NativeHistoryCliError(
      "usage: native-history-cli.ts <prepare|measure|measure-intents> SOURCE_TREE CORPUS_DIRECTORY"
    );
  }
  if (command === "prepare") {
    const descriptor = await prepareNativeHistoryCorpus(sourceTree, corpusDirectory);
    process.stdout.write(`${JSON.stringify({ command, sourceTree, corpusDirectory: resolve(corpusDirectory), descriptor })}\n`);
    return;
  }
  const corpus = await readNativeHistoryCorpus(corpusDirectory);
  const report = await measureNativeHistory({ sourceTree, repository: corpus.repository, descriptor: corpus.descriptor,
    ...(command === "measure-intents" ? { retainedIntentHistory: true } : {}) });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  await main();
} catch (error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { name, message: message.slice(0, 500) } })}\n`);
  process.exitCode = 1;
}
