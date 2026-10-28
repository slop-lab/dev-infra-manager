import { createHash } from "node:crypto";

export type PercentileSummary = {
  readonly count: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly maxMilliseconds: number;
};

export function percentileSummary(samples: readonly number[]): PercentileSummary {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new NativeHistoryMetricsError("timing samples must be present, finite and nonnegative");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Milliseconds: nearestRank(sorted, 0.5),
    p95Milliseconds: nearestRank(sorted, 0.95),
    maxMilliseconds: sorted[sorted.length - 1] ?? 0
  };
}

export function deterministicPatch(reviewIndex: number, bytes: number): Buffer {
  if (!Number.isInteger(reviewIndex) || reviewIndex < 0 || !Number.isInteger(bytes) || bytes < 0) {
    throw new NativeHistoryMetricsError("synthetic patch bounds are invalid");
  }
  const output = Buffer.allocUnsafe(bytes);
  let offset = 0;
  let block = 0;
  while (offset < bytes) {
    const digest = createHash("sha256")
      .update("dim-native-history-latency-v1\0")
      .update(String(reviewIndex))
      .update("\0")
      .update(String(block))
      .digest();
    const length = Math.min(digest.length, bytes - offset);
    for (let index = 0; index < length; index += 1) {
      output[offset + index] = 97 + (digest[index] ?? 0) % 26;
    }
    offset += length;
    block += 1;
  }
  return output;
}

export function reviewPayloadBytes(): readonly number[] {
  return [3_250_000, ...Array.from({ length: 139 }, () => 1_161_000)];
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.ceil(sorted.length * percentile) - 1;
  return sorted[index] ?? sorted[0] ?? 0;
}

export class NativeHistoryMetricsError extends Error {
  readonly name = "NativeHistoryMetricsError";
}
