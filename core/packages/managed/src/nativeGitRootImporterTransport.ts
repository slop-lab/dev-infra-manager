import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { pipeline } from "node:stream/promises";
import type { NativeGitAdmissionHttpResponse } from "./nativeGitAdmissionSource.js";
import type { NativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";

const maximumBodyBytes = 256 * 1024 * 1024;
const maximumPreludeBytes = 64 * 1024;
const maximumResponseBytes = 64 * 1024;

type UploadInput = {
  readonly connection: NativeGitRootImporterConnection;
  readonly authorization: string;
  readonly projectId: string;
  readonly prelude: object;
  readonly bundlePath: string;
  readonly signal: AbortSignal;
};

export class NativeGitRootImporterTransportError extends Error {
  readonly name = "NativeGitRootImporterTransportError";
}

export async function uploadNativeGitRootBundle(input: UploadInput): Promise<{
  readonly response: NativeGitAdmissionHttpResponse;
  readonly bundleDigest: string;
  readonly bundleSize: number;
}> {
  const prelude = Buffer.from(`${JSON.stringify(input.prelude)}\n`, "utf8");
  if (prelude.length < 2 || prelude.length > maximumPreludeBytes + 1) invalid();
  const file = await open(input.bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || !Number.isSafeInteger(size) || size < 1
      || size + prelude.length > maximumBodyBytes) invalid();
    const hash = createHash("sha256");
    let transferred = 0;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
    const received = await new Promise<NativeGitAdmissionHttpResponse>((resolve, reject) => {
      let reply: NativeGitAdmissionHttpResponse | undefined;
      let uploaded = false;
      const finish = () => {
        if (uploaded && reply !== undefined) resolve(reply);
      };
      const request = httpRequest(new URL(`/v1/projects/${input.projectId}/root-import`, input.connection.endpoint), {
        method: "POST", signal,
        headers: { authorization: input.authorization, accept: "application/json",
          "content-type": "application/octet-stream", "content-length": String(size + prelude.length) }
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maximumResponseBytes) {
            incoming.destroy(new NativeGitRootImporterTransportError("native Git root import response exceeds limit"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          reply = { statusCode: incoming.statusCode ?? 0,
            contentType: incoming.headers["content-type"],
            cacheControl: incoming.headers["cache-control"], body: Buffer.concat(chunks) };
          finish();
        });
        incoming.on("error", reject);
      });
      request.on("error", reject);
      request.write(prelude);
      const stream = file.createReadStream({ autoClose: false });
      stream.on("data", (chunk: string | Buffer) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        transferred += bytes.length;
        hash.update(bytes);
      });
      void pipeline(stream, request, { signal }).then(() => { uploaded = true; finish(); }, reject);
    });
    const after = await file.stat({ bigint: true });
    if (transferred !== size || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || before.ino !== after.ino || before.dev !== after.dev) invalid();
    return { response: received, bundleDigest: hash.digest("hex"), bundleSize: size };
  } finally {
    await file.close();
  }
}

function invalid(): never {
  throw new NativeGitRootImporterTransportError("native Git root import bundle is invalid");
}
