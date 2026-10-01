import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceBuildFixture,
  fixturePackageManifest,
  fixtureRootCommit,
  runSourceBuild,
  type SourceBuildFixture
} from "./localSourceBuildPolicy.fixture.js";

const sourceCommit = { DIM_SOURCE_ROOT_COMMIT: fixtureRootCommit } as const;

const fixtures: SourceBuildFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ root }) => rm(root, { recursive: true, force: true })));
});

describe("exact source plugin compilation", () => {
  it("installs the source workspace before ordered builds and packaging", async () => {
    const fixture = await createSourceBuildFixture();
    fixtures.push(fixture);
    const result = runSourceBuild(fixture, "pack-source-build.bash", sourceCommit);
    const invocations = (await readFile(fixture.log, "utf8")).trim().split("\n");

    expect(result.status).toBe(0);
    const pnpmInvocations = invocations.filter((invocation) => invocation.startsWith("pnpm "));
    expect(pnpmInvocations[0]).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+ install --frozen-lockfile version=/);
    expect(pnpmInvocations[1]).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+\/core run build version=/);
    expect(pnpmInvocations[2]).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+\/plugin-dns-cloudflare run build version=/);
    expect(pnpmInvocations[3]).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+\/plugin-external-urls run build version=/);
    expect(invocations.at(-1)).toMatch(/^node .*pack-local-packages\.mjs /);
    for (const repository of ["plugin-dns-cloudflare", "plugin-external-urls"]) {
      expect(await readFile(resolve(fixture.root, `output/${repository}.package.json`), "utf8")).toBe(fixturePackageManifest);
    }
  });

  it("stops before builds and packaging when the workspace install fails", async () => {
    const fixture = await createSourceBuildFixture();
    fixtures.push(fixture);
    const result = runSourceBuild(fixture, "pack-source-build.bash", {
      ...sourceCommit,
      DIM_WORKSPACE_INSTALL_FAILURE: "1"
    });
    const invocations = await readFile(fixture.log, "utf8");

    expect(result.status).toBe(42);
    expect(invocations.match(/^pnpm /gm)).toHaveLength(1);
    expect(invocations).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+ install --frozen-lockfile/m);
    expect(invocations).not.toMatch(/^pnpm .* run build /m);
    expect(invocations).not.toMatch(/^node .*pack-local-packages\.mjs /m);
  });
});
