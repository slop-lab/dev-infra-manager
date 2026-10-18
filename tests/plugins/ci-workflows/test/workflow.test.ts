import { describe, expect, it } from "vitest";
import { candidateArgv, dimWorkflowCompiler } from "../../../../plugin-ci-workflows/src/index.js";

describe("DIM workflow language", () => {
  it("compiles a script job with Sysbox defaults and an explicit QEMU job", () => {
    const jobs = dimWorkflowCompiler.compile(Buffer.from(`jobs:
  integration:
    script: scripts/integration.sh
    runtime: qemu
  source:
    script: tools/source-check
`));
    expect(jobs).toEqual([
      { name: "integration", kind: "qemu", script: "scripts/integration.sh", argv: candidateArgv },
      { name: "source", kind: "ordinary-sysbox", script: "tools/source-check", argv: candidateArgv }
    ]);
  });

  it("produces a deterministic plan regardless of declaration order", () => {
    const first = "jobs:\n  beta: {script: beta}\n  alpha: {script: alpha}\n";
    const reversed = "jobs:\n  alpha: {script: alpha}\n  beta: {script: beta}\n";
    expect(dimWorkflowCompiler.compile(Buffer.from(first))).toEqual(dimWorkflowCompiler.compile(Buffer.from(reversed)));
  });

  it("supports projects with no CI jobs", () => {
    expect(dimWorkflowCompiler.compile(Buffer.from("jobs: {}\n"))).toEqual([]);
  });
});
