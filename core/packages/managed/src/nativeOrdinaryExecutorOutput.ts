import { createHash, type Hash } from "node:crypto";
import { Writable } from "node:stream";

export type NativeBoundedOutput = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutEvidence: { readonly bytes: string; readonly sha256: string; readonly truncated: boolean };
  readonly stderrEvidence: { readonly bytes: string; readonly sha256: string; readonly truncated: boolean };
};

export function emptyNativeOutput(): NativeBoundedOutput {
  const emptyDigest = `sha256:${createHash("sha256").digest("hex")}`;
  return {
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    stdoutEvidence: { bytes: "0", sha256: emptyDigest, truncated: false },
    stderrEvidence: { bytes: "0", sha256: emptyDigest, truncated: false }
  };
}

type Channel = {
  readonly chunks: Buffer[];
  readonly hash: Hash;
  bytes: number;
  truncated: boolean;
};

export class NativeOutputCollector {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly #limit: number;
  readonly #abort: () => void;
  readonly #stdout = channel();
  readonly #stderr = channel();
  #total = 0;

  constructor(limit: number, abort: () => void) {
    this.#limit = limit;
    this.#abort = abort;
    this.stdout = this.#writer(this.#stdout);
    this.stderr = this.#writer(this.#stderr);
  }

  get exceeded(): boolean {
    return this.#stdout.truncated || this.#stderr.truncated;
  }

  result(): NativeBoundedOutput {
    return {
      stdout: Buffer.concat(this.#stdout.chunks), stderr: Buffer.concat(this.#stderr.chunks),
      stdoutEvidence: evidence(this.#stdout), stderrEvidence: evidence(this.#stderr)
    };
  }

  #writer(target: Channel): Writable {
    return new Writable({
      write: (chunk: Buffer | string, encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        const remaining = Math.max(0, this.#limit - this.#total);
        const accepted = bytes.subarray(0, remaining);
        if (accepted.length > 0) {
          target.chunks.push(accepted);
          target.hash.update(accepted);
          target.bytes += accepted.length;
          this.#total += accepted.length;
        }
        if (accepted.length !== bytes.length) {
          target.truncated = true;
          this.#abort();
        }
        callback();
      }
    });
  }
}

function channel(): Channel {
  return { chunks: [], hash: createHash("sha256"), bytes: 0, truncated: false };
}

function evidence(value: Channel): NativeBoundedOutput["stdoutEvidence"] {
  return { bytes: String(value.bytes), sha256: `sha256:${value.hash.digest("hex")}`, truncated: value.truncated };
}
