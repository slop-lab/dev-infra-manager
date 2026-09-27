import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];
const recipes = [
  { root: workspaceRoot, installCommand: "verification/scripts/install-dim-local.bash" },
  { root: resolve(workspaceRoot, "project"), installCommand: "scripts/install-source-build.bash" }
] as const;

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local control-plane installation", () => {
  it.each(recipes.flatMap((recipe) => [0, 47].map((installExit) => ({ ...recipe, installExit }))))(
    "restarts only after $installCommand exits $installExit",
    async ({ root, installCommand, installExit }) => {
    // Given
    const fixture = await mkdtemp(resolve(tmpdir(), "dim-control-plane-install-"));
    fixtureRoots.push(fixture);
    const log = resolve(fixture, "invocations.log");
    const tools = resolve(fixture, "tools");
    await writeFile(log, "");
    await mkdir(tools);
    await writeFile(resolve(tools, "bash"), `#!/usr/bin/bash
if [[ "$2" == *'bash ${installCommand}'* ]]; then
  printf 'install\n' >>"$DIM_INVOCATIONS"
  exit "$DIM_INSTALL_EXIT"
fi
printf 'restart\n' >>"$DIM_INVOCATIONS"
`);
    await chmod(resolve(tools, "bash"), 0o755);

    // When
    const result = spawnSync("/usr/local/bin/just", ["install-local-control-plane"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DIM_INVOCATIONS: log,
        DIM_INSTALL_EXIT: String(installExit)
      }
    });
    const invocations = await readFile(log, "utf8");

    // Then
    expect(result.status, result.stderr).toBe(installExit);
    expect(invocations.trim().split("\n")).toEqual(installExit === 0
      ? ["install", "restart"]
      : ["install"]);
    }
  );
});
