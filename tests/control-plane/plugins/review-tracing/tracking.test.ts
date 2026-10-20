import { describe, expect, it } from "vitest";
import { createReadTracker, evaluateTrackedProject, type ReviewTraceRuntime } from "../../../../packages/review-tracing/src/index.js";

const file = (files: Record<string, string>) => async (path: string) => files[path] === undefined ? undefined : Buffer.from(files[path]);
const runtime = (evaluate: ReviewTraceRuntime["evaluate"]): ReviewTraceRuntime => ({ name: "test", revision: "a".repeat(64), evaluate });
const baseline = { "check.mjs": "predicate", "helper.mjs": "helper", "settings.json": '{"safe":true,"label":"old"}' };
const predicate = runtime(async ({ readFile, readTargetFile }) => {
  await readFile("helper.mjs");
  const before = await readTargetFile("settings.json", "before"), after = await readTargetFile("settings.json", "after");
  return { matches: JSON.parse(before!.toString()).safe !== JSON.parse(after!.toString()).safe, manifest: [] };
});
function check(candidate: Record<string, string>, selected = predicate) {
  return evaluateTrackedProject({ runtime: selected, entrypoint: "check.mjs", changes: [], readBaseFile: file(baseline), readCandidateFile: file(candidate) });
}
describe("tracked review predicate dependencies", () => {
  it("lets target-only unrelated JSON fields change without whole-file review", async () => {
    expect((await check({ ...baseline, "settings.json": '{"safe":true,"label":"new"}' })).matches).toBe(false);
    expect((await check({ ...baseline, "settings.json": '{"safe":false}' })).matches).toBe(true);
  });
  it("protects entrypoint and host-observed imports even when runtime returns an empty manifest", async () => {
    expect((await check({ ...baseline, "check.mjs": "changed" })).matches).toBe(true);
    expect((await check({ ...baseline, "helper.mjs": "changed" })).matches).toBe(true);
    const removed: Record<string, string> = { ...baseline }; delete removed["helper.mjs"];
    expect((await check(removed)).matches).toBe(true);
  });
  it("requires review for newly activated dependencies and dependency-to-target demotion", async () => {
    const activated = runtime(async ({ readFile }) => {
      if ((await readFile("check.mjs"))?.toString() === "new predicate") await readFile("new-helper");
      return { matches: false, manifest: [] };
    });
    expect((await check({ ...baseline, "check.mjs": "new predicate", "new-helper": "new" }, activated)).matches).toBe(true);
    const demoted = runtime(async ({ readFile, readTargetFile }) => {
      if ((await readTargetFile("settings.json", "after"))?.toString().includes("new")) await readTargetFile("helper.mjs", "after");
      else await readFile("helper.mjs");
      return { matches: false, manifest: [] };
    });
    expect((await check({ ...baseline, "settings.json": '{"label":"new"}' }, demoted)).matches).toBe(true);
  });
  it("checks old dependencies that disappear from a candidate branch", async () => {
    const conditional = runtime(async ({ readFile, readTargetFile }) => {
      if (!(await readTargetFile("settings.json", "after"))?.toString().includes("skip")) await readFile("helper.mjs");
      return { matches: false, manifest: [] };
    });
    expect((await check({ ...baseline, "settings.json": '"skip"', "helper.mjs": "changed" }, conditional)).matches).toBe(true);
  });
  it("allows a broken baseline to be repaired through mandatory review but rejects a broken candidate", async () => {
    const failing = runtime(async ({ readFile }) => {
      if ((await readFile("check.mjs"))?.toString() === "predicate") throw new Error("broken");
      return { matches: false, manifest: [] };
    });
    expect((await check({ ...baseline, "check.mjs": "fixed" }, failing)).matches).toBe(true);
    await expect(check(baseline, failing)).rejects.toThrow("broken");
  });
  it("binds observations and runtime implementation to approval evidence", async () => {
    const unchanged = await check(baseline);
    expect(await check(baseline)).toEqual(unchanged);
    expect((await check({ ...baseline, "settings.json": '{"safe":true}' })).evidenceDigest).not.toBe(unchanged.evidenceDigest);
    expect((await check(baseline, { ...predicate, revision: "b".repeat(64) })).evidenceDigest).not.toBe(unchanged.evidenceDigest);
  });
  it("records absent reads and both roles, rejects traversal and mutation", async () => {
    let bytes = Buffer.from("one");
    const tracker = createReadTracker({ readFile: async () => bytes, readTargetFile: file({}) });
    await tracker.read("config", "dependency"); await tracker.read("config", "target", "before");
    expect(tracker.manifest()).toHaveLength(2);
    expect(tracker.manifest().find(({ role }) => role === "target")?.digest).toBeNull();
    await expect(tracker.read("../secret", "dependency")).rejects.toThrow("normalized");
    bytes = Buffer.from("two");
    await expect(tracker.read("config", "dependency")).rejects.toThrow("snapshot changed");
  });
});
