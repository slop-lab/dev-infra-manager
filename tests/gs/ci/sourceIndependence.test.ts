import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps the GS CI package dependency graph independent from DIM implementations", async () => {
  const root = new URL("../../../packages/gs/ci", import.meta.url).pathname;
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("dependencies" in manifest)
    || !manifest.dependencies || typeof manifest.dependencies !== "object") {
    throw new Error("GS CI manifest dependencies are unavailable");
  }
  expect(Object.keys(manifest.dependencies)).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/^@slop-lab\/dim-/),
  ]));
  const source = join(root, "src");
  const bodies = await Promise.all((await readdir(source))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFile(join(source, name), "utf8")));
  expect(bodies.some((body) => body.includes("@slop-lab/dim-"))).toBe(false);
});

it("keeps public GS workflow, check and event contracts free of DIM placement", async () => {
  const root = new URL("../../../packages/gs/ci-contracts/src", import.meta.url).pathname;
  const source = (await Promise.all(["candidate-execution.ts", "workflow.ts", "events.ts"]
    .map((name) => readFile(join(root, name), "utf8")))).join("\n");

  expect(source).not.toMatch(/ordinary-sysbox|qemu|runnerBaseImage|jobBaseImage|generationId|projectId|dim\.native/);
  expect(source).toMatch(/provider/);
});
