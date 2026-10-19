import { describe, expect, it } from "vitest";
import { dimWorkflowCompiler, WorkflowSyntaxError } from "../../../../plugin-control-plane-ci-workflows/src/index.js";

describe("DIM workflow input boundaries", () => {
  it.each([
    ["old grouped workflow", "schemaVersion: 4\nordinary: {jobs: {}}\nqemu: {jobs: {}}"],
    ["missing script", "jobs: {check: {}}"],
    ["unknown runtime", "jobs: {check: {script: check.sh, runtime: host}}"],
    ["candidate-selected image", "jobs: {check: {script: check.sh, image: mutable:latest}}"],
    ["candidate-selected argv", "jobs: {check: {script: check.sh, argv: [/bin/sh]}}"],
    ["candidate-selected credential", "jobs: {check: {script: check.sh, credential: host}}"],
    ["traversal", "jobs: {check: {script: ../host-secret}}"],
    ["absolute script", "jobs: {check: {script: /etc/shadow}}"],
    ["Git metadata", "jobs: {check: {script: .git/config}}"],
    ["duplicate job names", "jobs:\n  check: {script: one}\n  check: {script: two}"],
    ["YAML aliases", "jobs:\n  check: &job {script: one}\n  other: *job"],
    ["YAML tags", "jobs: {check: {script: !!str one}}"]
  ])("rejects %s", (_name, source) => {
    expect(() => dimWorkflowCompiler.compile(Buffer.from(source))).toThrow(WorkflowSyntaxError);
  });

  it("rejects invalid UTF-8, NUL and oversized configuration bytes", () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("jobs: {}\0"), Buffer.alloc(65_537, 32)]) {
      expect(() => dimWorkflowCompiler.compile(bytes)).toThrow(WorkflowSyntaxError);
    }
  });

  it("bounds the number of jobs", () => {
    const jobs = Object.fromEntries(Array.from({ length: 65 }, (_unused, index) => [`job-${index}`, { script: "check.sh" }]));
    expect(() => dimWorkflowCompiler.compile(Buffer.from(JSON.stringify({ jobs })))).toThrow(WorkflowSyntaxError);
  });
});
