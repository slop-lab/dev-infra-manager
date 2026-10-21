import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { UserError } from "@slop-lab/dim-host-core";

const maximumPolicyBytes = 64 * 1024;

export type NativeRepositoryPolicyFile = {
  readonly repositoryId: string;
  readonly extensions: unknown;
};

export async function readNativeRepositoryPolicyFile(policyPath: string): Promise<NativeRepositoryPolicyFile> {
  return parseNativeRepositoryPolicyFile(await readNativeReviewedPolicyText(policyPath));
}

/** Both JSON policy and YAML manifests authorize host-managed protected policy. */
export async function readNativeReviewedPolicyText(policyPath: string): Promise<string> {
  if (!path.isAbsolute(policyPath)) {
    throw new UserError("repository policy path must be absolute");
  }
  let file: FileHandle;
  try {
    file = await open(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new UserError("repository policy file could not be opened safely", { cause: error });
  }
  try {
    const metadata = await file.stat({ bigint: true });
    const owner = process.geteuid?.();
    if (!metadata.isFile() || metadata.isSymbolicLink() || owner === undefined
      || metadata.uid !== BigInt(owner) || metadata.nlink !== 1n || (metadata.mode & 0o022n) !== 0n) {
      throw new UserError(
        "repository policy must be a caller-owned, single-link, non-group/world-writable regular file"
      );
    }
    if (metadata.size > BigInt(maximumPolicyBytes)) {
      throw new UserError("repository policy exceeds 64 KiB");
    }
    const bytes = Buffer.alloc(maximumPolicyBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximumPolicyBytes) throw new UserError("repository policy exceeds 64 KiB");
    const after = await file.stat({ bigint: true });
    if (!sameFile(metadata, after)) {
      throw new UserError("repository policy changed during inspection");
    }
    return bytes.toString("utf8", 0, length);
  } finally {
    await file.close();
  }
}

function parseNativeRepositoryPolicyFile(serialized: string): NativeRepositoryPolicyFile {
  let value: unknown;
  try {
    if (hasDuplicateJsonKeys(serialized)) throw new SyntaxError("duplicate JSON object key");
    value = JSON.parse(serialized);
  } catch (error) {
    throw new UserError("repository policy is invalid JSON", { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.repositoryId !== "string"
    || !Object.hasOwn(value, "extensions")
    || Object.keys(value).some((key) => !["schemaVersion", "repositoryId", "extensions"].includes(key))) {
    throw new UserError("repository policy must contain exactly schemaVersion 1, repositoryId, and extensions");
  }
  return { repositoryId: value.repositoryId, extensions: value.extensions };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hasDuplicateJsonKeys(text: string): boolean {
  const stack: Array<{ keys: Set<string> | undefined; keyExpected: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      stack.push({ keys: new Set(), keyExpected: true });
    } else if (character === "[") {
      stack.push({ keys: undefined, keyExpected: false });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const top = stack.at(-1);
      if (top?.keys !== undefined) top.keyExpected = true;
    } else if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') break;
        index += 1;
      }
      const top = stack.at(-1);
      if (top?.keys !== undefined && top.keyExpected) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== "string" || top.keys.has(key)) return true;
        top.keys.add(key);
        top.keyExpected = false;
      }
    }
  }
  return false;
}
