import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { GitExecutableIdentity } from "./repository.js";
import { verifyNativeRootBundle } from "./native-root-import-git.js";
import {
  assertDurableNativeRootBundle,
  assertPrivateDirectory,
  NativeRootImportBundleError,
  rootBundleDirectory,
  rootBundlePath,
  syncDirectory
} from "./native-root-import-storage.js";

const maximumPreludeBytes = 64 * 1024;
const maximumRequestBytes = 256 * 1024 * 1024;
const preludeSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  serviceId: z.literal("native-main"),
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  rootRepositoryId: z.literal("root"),
  protectedRef: z.string(),
  expectedCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  policy: z.unknown()
}).strict().readonly();

export type NativeRootImportPrelude = z.infer<typeof preludeSchema>;
export type NativeRootBundleReceipt = {
  readonly prelude: NativeRootImportPrelude;
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly bundlePath: string;
};

type ReceiveOptions = {
  readonly request: IncomingMessage;
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly signal: AbortSignal;
  readonly authorizePrelude: (prelude: NativeRootImportPrelude) => string | Promise<string>;
};

export async function receiveNativeRootBundle(options: ReceiveOptions): Promise<NativeRootBundleReceipt> {
  if (options.request.headers["content-type"] !== "application/octet-stream") {
    throw new NativeRootImportBundleError("root import content type is invalid");
  }
  const contentLength = options.request.headers["content-length"];
  if (typeof contentLength !== "string" || !/^[1-9][0-9]*$/.test(contentLength)) {
    throw new NativeRootImportBundleError("root import content length is required");
  }
  const expectedBytes = Number(contentLength);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > maximumRequestBytes) {
    throw new NativeRootImportBundleError("root import request is too large");
  }
  const hash = createHash("sha256");
  const preludeChunks: Buffer[] = [];
  let preludeBytes = 0;
  let receivedBytes = 0;
  let bundleSize = 0;
  let prelude: NativeRootImportPrelude | undefined;
  let importNonce: string | undefined;
  const iterator = options.request[Symbol.asyncIterator]();
  let firstBundleChunk = Buffer.alloc(0);
  while (prelude === undefined) {
    options.signal.throwIfAborted();
    const next = await iterator.next();
    if (next.done) throw new NativeRootImportBundleError("root import body is truncated");
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    receivedBytes += chunk.length;
    if (receivedBytes > expectedBytes) throw new NativeRootImportBundleError("root import body exceeds content length");
    const newline = chunk.indexOf(0x0a);
    if (newline < 0) {
      preludeBytes += chunk.length;
      if (preludeBytes > maximumPreludeBytes) throw new NativeRootImportBundleError("root import prelude is too large");
      preludeChunks.push(chunk);
      continue;
    }
    preludeBytes += newline;
    if (preludeBytes === 0 || preludeBytes > maximumPreludeBytes) {
      throw new NativeRootImportBundleError("root import prelude is invalid");
    }
    preludeChunks.push(chunk.subarray(0, newline));
    prelude = parsePrelude(Buffer.concat(preludeChunks));
    if (prelude.projectId !== options.projectId) throw new NativeRootImportBundleError("root import Project path conflicts");
    importNonce = await options.authorizePrelude(prelude);
    firstBundleChunk = chunk.subarray(newline + 1);
  }
  const projectRoot = join(options.stateDirectory, options.projectId);
  await assertPrivateDirectory(projectRoot);
  const directory = rootBundleDirectory(options.stateDirectory, options.projectId);
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    await chmod(directory, 0o700);
    await syncDirectory(projectRoot);
  }
  await assertPrivateDirectory(directory);
  const temporaryPath = join(directory, `.${randomUUID()}.upload`);
  const file = await open(temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await file.chmod(0o600);
      if (firstBundleChunk.length > 0) {
        await file.write(firstBundleChunk);
        hash.update(firstBundleChunk);
        bundleSize += firstBundleChunk.length;
      }
      while (true) {
        options.signal.throwIfAborted();
        const next = await iterator.next();
        if (next.done) break;
        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        receivedBytes += chunk.length;
        if (receivedBytes > expectedBytes) throw new NativeRootImportBundleError("root import body exceeds content length");
        await file.write(chunk);
        hash.update(chunk);
        bundleSize += chunk.length;
      }
      if (receivedBytes !== expectedBytes || bundleSize === 0) {
        throw new NativeRootImportBundleError("root import body is truncated");
      }
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError: unknown) => {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;
    });
    throw error;
  }
  if (importNonce === undefined) throw new NativeRootImportBundleError("root import intent is missing");
  const finalPath = rootBundlePath(options.stateDirectory, options.projectId, importNonce);
  const bundleDigest = hash.digest("hex");
  try {
    await verifyNativeRootBundle({
      bundlePath: temporaryPath,
      directory,
      canonicalRepository: join(projectRoot, "root.git"),
      protectedRef: prelude.protectedRef,
      expectedCommit: prelude.expectedCommit,
      gitExecutable: options.gitExecutable,
      gitIdentity: options.gitIdentity,
      signal: options.signal
    });
    options.signal.throwIfAborted();
    try {
      await lstat(finalPath);
      await unlink(temporaryPath);
      await assertDurableNativeRootBundle(options.stateDirectory, options.projectId, importNonce,
        bundleDigest, bundleSize);
      return { prelude, bundleDigest, bundleSize, bundlePath: finalPath };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(temporaryPath, finalPath);
    await syncDirectory(directory);
    return { prelude, bundleDigest, bundleSize, bundlePath: finalPath };
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError: unknown) => {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;
    });
    throw error;
  }
}

function parsePrelude(bytes: Buffer): NativeRootImportPrelude {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeRootImportBundleError("root import prelude is invalid", { cause: error });
    throw error;
  }
  const result = preludeSchema.safeParse(value);
  if (!result.success) throw new NativeRootImportBundleError("root import prelude is invalid", { cause: result.error });
  return result.data;
}
