import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dimWorkflowCompiler } from "../../../packages/control-plane/plugins/ci-workflows/src/index.js";
it("compiles source-only and explicit hardware qualification workflows without candidate image authority", async () => {
  // Exercise the ordinary compiler default independently of the candidate-selected workflow.
  const current = Buffer.from("jobs:\n  source:\n    script: scripts/ci/source.bash\n");
  const example = await readFile(new URL("../../../.dim/ci/practical.example.yml", import.meta.url));
  expect(dimWorkflowCompiler.compile(current).map(job => ({ name: job.name, provider: job.provider }))).toEqual([{ name: "source", provider: "ordinary-sysbox" }]);
  expect(dimWorkflowCompiler.compile(example).map(job => ({ name: job.name, provider: job.provider, script: job.script }))).toEqual([
    { name: "practical", provider: "qemu", script: "scripts/ci/practical-cold.bash" },
    { name: "source", provider: "ordinary-sysbox", script: "scripts/ci/source.bash" }
  ]);
  for (const [file, script] of [["practical-runtime.example.yml", "practical.bash"], ["practical-cached.example.yml", "practical-cached.bash"]]) {
    const jobs = dimWorkflowCompiler.compile(await readFile(new URL(`../../../.dim/ci/${file}`, import.meta.url)));
    expect(jobs.find(job => job.provider === "qemu")?.script).toBe(`scripts/ci/${script}`);
  }
});
