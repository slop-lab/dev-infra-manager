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
    const retainedArgumentsFile = resolve(temporaryDirectory, "retained-arguments");
    const ordinaryArgumentsFile = resolve(temporaryDirectory, "ordinary-arguments");
    const docker = resolve(dockerDirectory, "docker");
    await mkdir(dockerDirectory);
    await writeFile(
      docker,
      `#!/usr/bin/env sh
{
  printf 'CALL'
  printf '\\t%s' "$@"
  printf '\\n'
} >>"$DIM_TEST_ARGUMENTS"
case " $* " in
  *" ps --quiet agent-dind "*) printf 'agent-dind-id\\n' ;;
esac
`
    );
    await chmod(docker, 0o700);

    const runTeardown = (keepVolume: boolean, argumentsFile: string) => {
      const environment = {
        ...process.env,
        PATH: `${dockerDirectory}:/usr/bin:/bin`,
        DIM_TEST_ARGUMENTS: argumentsFile
      };
      if (keepVolume) environment.DIM_WORKSPACE_DISCARD_KEEP_VOLUME = "1";
      else delete environment.DIM_WORKSPACE_DISCARD_KEEP_VOLUME;
      return spawnSync("sh", [teardown], { env: environment, encoding: "utf8" });
    };

    const discardCall =
      "CALL\tcompose\t--file\t.dim/docker-compose.yml\texec\t--no-TTY\t--user\troot\tagent-dind\tdim-agent-dind\tdiscard-agent-tmp";

    try {
      expect(runTeardown(true, retainedArgumentsFile).status).toBe(0);
      const retainedCalls = await readFile(retainedArgumentsFile, "utf8");
      expect(retainedCalls).toContain(discardCall);
      expect(retainedCalls).toContain(
        "CALL\tcompose\t--file\t.dim/docker-compose.yml\tdown\t--remove-orphans"
      );
      expect(retainedCalls).not.toContain("\tdown\t--volumes");

      expect(runTeardown(false, ordinaryArgumentsFile).status).toBe(0);
      const ordinaryCalls = await readFile(ordinaryArgumentsFile, "utf8");
      expect(ordinaryCalls).toContain(discardCall);
      expect(ordinaryCalls).toContain(
        "CALL\tcompose\t--file\t.dim/docker-compose.yml\tdown\t--volumes\t--remove-orphans"
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
