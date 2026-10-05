import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readReviewJson } from "./review-record-storage.js";

const maximumRecordBytes = 128 * 1024 * 1024;
const filePattern = /^[0-9a-f-]+\.json$/;

export async function readReviewEvidenceRecords<T>(
  directory: string,
  parse: (input: unknown) => T
): Promise<readonly T[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const values: T[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !filePattern.test(entry.name)) throw new ReviewEvidenceRecordError("review event entry is invalid");
    values.push(parse(await readReviewJson(join(directory, entry.name), maximumRecordBytes)));
  }
  return values;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

class ReviewEvidenceRecordError extends Error {
  readonly name = "ReviewEvidenceRecordError";
}
