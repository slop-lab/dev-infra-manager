import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  deterministicPatch,
  percentileSummary
} from "./native-history-metrics.js";

test("percentileSummary reports bounded nearest-rank evidence", () => {
  const summary = percentileSummary([50, 10, 40, 20, 30]);

  assert.deepEqual(summary, {
    count: 5,
    p50Milliseconds: 30,
    p95Milliseconds: 50,
    maxMilliseconds: 50
  });
});

test("deterministicPatch produces stable synthetic bytes for each review", () => {
  const first = deterministicPatch(17, 1_024);
  const repeated = deterministicPatch(17, 1_024);
  const next = deterministicPatch(18, 1_024);

  assert.equal(first.length, 1_024);
  assert.deepEqual(first, repeated);
  assert.notEqual(
    createHash("sha256").update(first).digest("hex"),
    createHash("sha256").update(next).digest("hex")
  );
});

test("timing summaries reject absent or invalid measurements rather than emitting misleading JSON", () => {
  for (const samples of [[], [NaN], [Infinity], [-1]]) {
    assert.throws(() => percentileSummary(samples), { name: "NativeHistoryMetricsError" });
  }
  assert.equal(percentileSummary([0]).p50Milliseconds, 0);
});
