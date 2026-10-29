import { afterEach, expect, it } from "vitest";
import { cleanupAuthorityFixtures } from "./fixture.js";
import { runScopedBenchmark } from "./scoped-benchmark.js";

afterEach(cleanupAuthorityFixtures);

it("keeps warm selected-repository work bounded by indexed scoped history", async () => {
  const result = await runScopedBenchmark(2_000);
  expect(result.selectedHistory).toBe(1);
  expect(result.queryPlans.every((detail) => detail.includes("SEARCH"))).toBe(true);
  expect(result.selectorMilliseconds).toBeLessThan(500);
  expect(result.resolveMilliseconds).toBeLessThan(2_000);
  expect(result.lookupMilliseconds).toBeLessThan(1_000);
  expect(result.promotionMilliseconds).toBeLessThan(2_000);
}, 30_000);
