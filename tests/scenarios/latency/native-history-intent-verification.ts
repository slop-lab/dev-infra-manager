import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { deliveryIntentKey, deliveryIntentSchema } from "../../../packages/gs/ci/src/delivery-intent-record.js";
import { readPrivateCorpusRecord } from "./native-history-corpus-verification.js";

export type RetainedIntentHistoryDescriptor = {
  readonly recordCount: number;
  readonly bytes: number;
  readonly fingerprint: string;
};

export async function verifyRetainedHistoryIntents(directory: string,
  expected: RetainedIntentHistoryDescriptor,
  additionalNames: readonly string[] = []): Promise<RetainedIntentHistoryDescriptor> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.()
    || (metadata.mode & 0o777) !== 0o700) invalid();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name))) invalid();
  const names = entries.map(({ name }) => name).sort();
  if (additionalNames.some((name) => !names.includes(name))) invalid();
  const retained = names.filter((name) => !additionalNames.includes(name));
  if (retained.length !== expected.recordCount) invalid();
  const hash = createHash("sha256").update("dim-native-history-intents-v1\0");
  let bytes = 0;
  for (const name of retained) {
    const content = await readPrivateCorpusRecord(join(directory, name), 4 * 1024);
    const value: unknown = JSON.parse(content.toString("utf8"));
    const intent = deliveryIntentSchema.parse(value);
    if (intent.state !== "completed" || name !== `${deliveryIntentKey(intent)}.json`) invalid();
    hash.update(name).update("\0").update(content);
    bytes += content.length;
  }
  const fingerprint = `sha256:${hash.digest("hex")}`;
  if (bytes !== expected.bytes || fingerprint !== expected.fingerprint) invalid();
  return Object.freeze({ recordCount: retained.length, bytes, fingerprint });
}

function invalid(): never { throw new RetainedIntentHistoryVerificationError("retained intent history no longer matches its descriptor"); }
export class RetainedIntentHistoryVerificationError extends Error {
  readonly name = "RetainedIntentHistoryVerificationError";
}
