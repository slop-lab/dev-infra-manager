import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM workspace teardown policy", () => {
  it("preserves Compose volumes only for retained workspace discard", async () => {
    const teardown = resolve(
      workspaceRoot,
      "examples/projects/full-development-flow/repos/root/.dim/teardown.sh"
    );
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "dim-teardown-policy-"));
    const dockerDirectory = resolve(temporaryDirectory, "bin");
    const argumentsFile = resolve(temporaryDirectory, "arguments");
    const docker = resolve(dockerDirectory, "docker");
    await mkdir(dockerDirectory);
    await writeFile(
      docker,
      '#!/usr/bin/env sh\nprintf "%s\\n" "$@" >"$DIM_TEST_ARGUMENTS"\n'
    );
    await chmod(docker, 0o700);

    const runTeardown = (keepVolume: boolean) => {
      const environment = {
        ...process.env,
        PATH: `${dockerDirectory}:/usr/bin:/bin`,
        DIM_TEST_ARGUMENTS: argumentsFile
      };
      if (keepVolume) environment.DIM_WORKSPACE_DISCARD_KEEP_VOLUME = "1";
      else delete environment.DIM_WORKSPACE_DISCARD_KEEP_VOLUME;
      return spawnSync("sh", [teardown], { env: environment, encoding: "utf8" });
    };

    try {
      expect(runTeardown(true).status).toBe(0);
      expect(await readFile(argumentsFile, "utf8")).toBe(
        "compose\n--file\n.dim/docker-compose.yml\ndown\n--remove-orphans\n"
      );
      expect(runTeardown(false).status).toBe(0);
      expect(await readFile(argumentsFile, "utf8")).toBe(
        "compose\n--file\n.dim/docker-compose.yml\ndown\n--volumes\n--remove-orphans\n"
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
