import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dimWorkflowCompiler } from "../../../packages/control-plane/plugins/ci-workflows/src/index.js";
it("keeps default development requests source-only and makes hardware qualification an explicit candidate opt-in", async () => {
  const current = await readFile(new URL("../../../.dim/ci/runner.yml", import.meta.url));
  const example = await readFile(new URL("../../../.dim/ci/practical.example.yml", import.meta.url));
  expect(dimWorkflowCompiler.compile(current).map(job => ({ name: job.name, provider: job.provider }))).toEqual([{ name: "source", provider: "ordinary-sysbox" }]);
  expect(dimWorkflowCompiler.compile(example).map(job => ({ name: job.name, provider: job.provider, script: job.script }))).toEqual([
    { name: "practical", provider: "qemu", script: "scripts/ci/practical.bash" },
    { name: "source", provider: "ordinary-sysbox", script: "scripts/ci/source.bash" }
  ]);
});
