import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceBuildFixture,
  fixtureLockfile,
  fixturePackageManifest,
  runSourceBuild,
  type SourceBuildFixture
} from "./localSourceBuildPolicy.fixture.js";

const commits = {
  DIM_SOURCE_CORE_COMMIT: "1".repeat(40),
  DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT: "2".repeat(40),
  DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT: "3".repeat(40)
} as const;

const fixtures: SourceBuildFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ root }) => rm(root, { recursive: true, force: true })));
});

describe("exact source plugin compilation", () => {
  it("installs the source workspace before ordered builds and packaging", async () => {
    const fixture = await createSourceBuildFixture();
    fixtures.push(fixture);
    const sourceRoot = resolve(fixture.root, ".local/production-source");

    const result = runSourceBuild(fixture, "pack-source-build.bash", commits);
    const invocations = (await readFile(fixture.log, "utf8")).trim().split("\n");

    expect(result.status).toBe(0);
    const pnpmInvocations = invocations.filter((invocation) => invocation.startsWith("pnpm "));
    expect(pnpmInvocations.map((invocation) => invocation.replace(/ version=.*/, ""))).toEqual([
      `pnpm --dir ${sourceRoot} install --frozen-lockfile`,
      `pnpm --dir ${sourceRoot}/core run build`,
      `pnpm --dir ${sourceRoot}/plugin-dns-cloudflare run build`,
      `pnpm --dir ${sourceRoot}/plugin-external-urls run build`
    ]);
    expect(invocations.at(-1)).toMatch(/^node .*pack-local-packages\.mjs /);
    for (const repository of ["plugin-dns-cloudflare", "plugin-external-urls"]) {
      expect(await readFile(resolve(sourceRoot, repository, "package.json"), "utf8")).toBe(fixturePackageManifest);
      expect(await readFile(resolve(sourceRoot, repository, "pnpm-lock.yaml"), "utf8")).toBe(fixtureLockfile);
    }
  });

  it("stops before builds and packaging when the workspace install fails", async () => {
    const fixture = await createSourceBuildFixture();
    fixtures.push(fixture);
    const sourceRoot = resolve(fixture.root, ".local/production-source");

    const result = runSourceBuild(fixture, "pack-source-build.bash", {
      ...commits,
      DIM_WORKSPACE_INSTALL_FAILURE: "1"
    });
    const invocations = await readFile(fixture.log, "utf8");

    expect(result.status).toBe(42);
    expect(invocations.match(/^pnpm /gm)).toHaveLength(1);
    expect(invocations).toContain(`pnpm --dir ${sourceRoot} install --frozen-lockfile`);
    expect(invocations).not.toMatch(/^pnpm .* run build /m);
    expect(invocations).not.toMatch(/^node .*pack-local-packages\.mjs /m);
  });
});
