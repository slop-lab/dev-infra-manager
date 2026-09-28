import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("self-Project CI job image", () => {
  it("pins a job image with sed for pnpm-generated executable shims", async () => {
    const config: unknown = parse(await readFile(resolve(workspaceRoot, ".dim/ci/runner.yml"), "utf8"));
    const workload = {
      tools: expect.arrayContaining(["sed", "node", "git"]),
      image: expect.stringMatching(/^nixery\.dev\/.*\/gnused\/.*@sha256:[0-9a-f]{64}$/)
    };

    expect(config).toMatchObject({ workloads: { ordinary: workload, integration: workload } });
  });
});
