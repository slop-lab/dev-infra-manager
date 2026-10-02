import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM workspace teardown policy", () => {
  it("preserves Compose volumes only for retained workspace discard", async () => {
    const projectRoot = resolve(
      workspaceRoot,
      "examples/projects/full-development-flow/repos/root"
    );
    const teardown = resolve(projectRoot, ".dim/teardown.sh");
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
  *" ps --all --quiet agent-dind "*) printf 'stopped-agent-dind\\n' ;;
  *" inspect --format "*"/mnt/agent-tmp"*) printf 'volume|project_agent-tmp\\n' ;;
  *" inspect --format "*"/mnt/agent-home"*) printf 'volume|project_agent-home\\n' ;;
  *" inspect --format "*"com.docker.compose.project"*" stopped-agent-dind "*) printf 'project\\n' ;;
  *" volume inspect --format "*" project_agent-home "*) printf 'local|null|project|agent-home\\n' ;;
  *" volume inspect --format "*" project_agent-tmp "*) printf 'local|null|project|agent-tmp|agent-tmp\\n' ;;
esac
`
    );
    await chmod(docker, 0o700);

    const runTeardown = (keepVolume: boolean, argumentsFile: string) => {
      const environment = {
        ...process.env,
        PATH: `${dockerDirectory}:/usr/bin:/bin`,
        DIM_TEST_ARGUMENTS: argumentsFile,
        COMPOSE_PROJECT_NAME: "project"
      };
      if (keepVolume) environment.DIM_WORKSPACE_DISCARD_KEEP_VOLUME = "1";
      else delete environment.DIM_WORKSPACE_DISCARD_KEEP_VOLUME;
      return spawnSync("sh", [teardown], { cwd: projectRoot, env: environment, encoding: "utf8" });
    };

    const stoppedLookup =
      "CALL\tcompose\t--file\t.dim/docker-compose.yml\tps\t--all\t--quiet\tagent-dind";
    const containerRemoval = "CALL\trm\t--force\tstopped-agent-dind";
    const temporaryVolumeRemoval = "CALL\tvolume\trm\tproject_agent-tmp";

    try {
      const retainedResult = runTeardown(true, retainedArgumentsFile);
      expect(retainedResult.status, retainedResult.stderr).toBe(0);
      const retainedCalls = await readFile(retainedArgumentsFile, "utf8");
      expect(retainedCalls).toContain(stoppedLookup);
      expect(retainedCalls).toContain(containerRemoval);
      expect(retainedCalls).toContain(temporaryVolumeRemoval);
      expect(retainedCalls).toContain(
        "CALL\tcompose\t--file\t.dim/docker-compose.yml\tdown\t--remove-orphans"
      );
      expect(retainedCalls).not.toContain("\tdown\t--volumes");

      const ordinaryResult = runTeardown(false, ordinaryArgumentsFile);
      expect(ordinaryResult.status, ordinaryResult.stderr).toBe(0);
      const ordinaryCalls = await readFile(ordinaryArgumentsFile, "utf8");
      expect(ordinaryCalls).toContain(stoppedLookup);
      expect(ordinaryCalls).toContain(containerRemoval);
      expect(ordinaryCalls).toContain(temporaryVolumeRemoval);
      expect(ordinaryCalls).toContain(
        "CALL\tcompose\t--file\t.dim/docker-compose.yml\tdown\t--volumes\t--remove-orphans"
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
