import { describe, expect, it } from "vitest";
import { parseCgroupReadback, kernelLimitsMatch } from "./cgroup.js";

describe("parseCgroupReadback", () => {
  it("Given current and ancestor cgroups, when parsed, then their kernel values remain ordered", () => {
    const result = parseCgroupReadback("/workspace|100000 100000|2147483648|512\n/|max 100000|max|max\n");
    expect(result).toEqual([
      { path: "/workspace", cpuQuota: "100000", cpuPeriod: "100000", memory: "2147483648", pids: "512" },
      { path: "/", cpuQuota: "max", cpuPeriod: "100000", memory: "max", pids: "max" }
    ]);
  });

  it("Given one bounded level and an unlimited ancestor, when checked, then actual finite limits match", () => {
    const levels = parseCgroupReadback("/workspace|100000 100000|2147483648|512\n/|max 100000|max|max\n");
    expect(kernelLimitsMatch(levels, { cpu: "1", memory: "2g", pids: "512" })).toBe(true);
  });

  it("Given one resource removed while other ceilings remain, when checked, then the matching kernel level is required", () => {
    const levels = parseCgroupReadback("/workspace|max 100000|2147483648|512\n/|200000 100000|4294967296|1024\n");
    expect(kernelLimitsMatch(levels, { cpu: "unlimited", memory: "2g", pids: "512" })).toBe(true);
    expect(kernelLimitsMatch(levels, { cpu: "unlimited", memory: "unlimited", pids: "512" })).toBe(false);
  });
});
