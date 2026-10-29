import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const packageNames = ["repository-contracts", "review-contracts", "ci-contracts", "diff", "blame", "discussions", "pull-requests", "client"] as const;

it("builds and operates the GS client graph outside DIM with an injected transport", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gs-client-source-owner-"));
  const owner = join(root, "gs");
  const execute = promisify(execFile);
  const require = createRequire(import.meta.url);
  try {
    await mkdir(owner, { recursive: true });
    for (const name of ["build-package.ts", "tsconfig.base.json", "LICENSE"]) {
      await cp(new URL(`../../packages/gs/${name}`, import.meta.url), join(owner, name));
    }
    for (const name of packageNames) {
      await cp(new URL(`../../packages/gs/${name}`, import.meta.url), join(owner, name), {
        recursive: true,
        filter: (source) => !source.split("/").some((part) => part === "node_modules" || part === "dist"),
      });
    }
    await linkDependencies(owner, require);
    await mkdir(join(root, "node_modules/@slop-lab"), { recursive: true });
    await symlink(join(owner, "client"), join(root, "node_modules/@slop-lab/gs-client"), "dir");
    for (const name of packageNames) {
      await execute(process.execPath, [join(owner, "build-package.ts")], {
        cwd: join(owner, name),
        env: { ...process.env, NODE_PATH: "", GS_BUILD_VERSION: "0.10.0-p2-client" },
        timeout: 60_000,
      });
    }
    const driver = join(root, "driver.mjs");
    await writeFile(driver, `
      import { createGitServiceClient } from "@slop-lab/gs-client";
      const requests = [];
      const client = createGitServiceClient({ capabilities: ["git-diff"], transport: { request(input) {
        requests.push(input); return Promise.resolve({ baseCommit: "${"a".repeat(40)}", headCommit: "${"b".repeat(40)}", files: [] });
      } } });
      const result = await client.readDiff({ namespaceId: "example", repositoryId: "app", baseCommit: "${"a".repeat(40)}", headCommit: "${"b".repeat(40)}" });
      process.stdout.write(JSON.stringify({ result, request: requests[0] }));
    `);

    // When
    const executed = await execute(process.execPath, [driver], { cwd: root, env: { ...process.env, NODE_PATH: "" } });

    // Then
    const output: unknown = JSON.parse(executed.stdout);
    expect(output).toMatchObject({
      result: { baseCommit: "a".repeat(40), headCommit: "b".repeat(40), files: [] },
      request: { kind: "diff.read", selector: { namespaceId: "example", repositoryId: "app" }, responseLimitBytes: 8 * 1024 * 1024 },
    });
    const manifest: unknown = JSON.parse(await readFile(join(owner, "client/dist/package.json"), "utf8"));
    expect(manifest).toMatchObject({ version: "0.10.0-p2-client" });
    expect(JSON.stringify(manifest)).not.toContain("@slop-lab/dim-");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

async function linkDependencies(owner: string, require: NodeJS.Require): Promise<void> {
  for (const name of packageNames) {
    const modules = join(owner, name, "node_modules");
    await mkdir(join(modules, "@slop-lab"), { recursive: true });
    await mkdir(join(modules, "@types"), { recursive: true });
    for (const [dependency, manifest] of [
      ["typescript", require.resolve("typescript/package.json")],
      ["@types/node", require.resolve("@types/node/package.json")],
      ["undici-types", require.resolve("undici-types/package.json")],
      ["zod", require.resolve("zod/package.json")],
    ] as const) {
      const destination = join(modules, dependency);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(dirname(manifest), destination, "dir");
    }
    for (const dependency of packageNames) {
      if (dependency !== name) await symlink(join(owner, dependency), join(modules, "@slop-lab", `gs-${dependency}`), "dir");
    }
  }
}
