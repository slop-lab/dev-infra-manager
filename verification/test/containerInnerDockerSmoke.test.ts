import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
let smoke = "";
let runtimeBackends = "";
const fixtureRoots: string[] = [];

type Fixture = {
  readonly log: string;
  readonly root: string;
  readonly smoke: string;
  readonly state: string;
};

beforeAll(async () => {
  [smoke, runtimeBackends] = await Promise.all([
    readFile(resolve(workspaceRoot, "verification/scripts/container-inner-docker-smoke.bash"), "utf8"),
    readFile(resolve(workspaceRoot, "core/packages/core/src/runtimeBackends.ts"), "utf8"),
  ]);
});

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-container-inner-smoke-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "verification/scripts");
  const tools = resolve(root, "tools");
  const state = resolve(root, "state");
  const log = resolve(root, "docker.log");
  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(tools), mkdir(state)]);
  const fixtureSmoke = resolve(scripts, "container-inner-docker-smoke.bash");
  await writeFile(fixtureSmoke, smoke, { mode: 0o700 });
  await writeFile(resolve(scripts, "local-build-version.bash"), `#!/usr/bin/env bash\nprintf '0.9.0-local-%064d\\n' 0\n`, { mode: 0o700 });
  await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(resolve(tools, "docker"), `#!/usr/bin/env bash
set -u
printf '%q ' "$@" >>"$DIM_TEST_LOG"; printf '\n' >>"$DIM_TEST_LOG"
command="\${1:-}"; shift || true
arguments=" $* "
container_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
resource="container-inner-docker-smoke"
container_name=""
for ((index=1; index<=$#; index++)); do
  [[ "\${!index}" != --name ]] || { next=$((index+1)); container_name="\${!next}"; }
done
case "$command" in
  run)
    if [[ "$arguments" == *" --entrypoint id "* ]]; then
      [[ "$arguments" == *" -g dim "* ]] && printf '1000\n' || printf '1000\n'
      exit 0
    fi
    if [[ -n "$container_name" ]]; then
      : >"$DIM_TEST_STATE/container-$container_name"
      if [[ "$container_name" == dim-inner-smoke-* ]]; then
        [[ "$DIM_TEST_FAILURE" != original-failure ]] || exit 42
        printf 'inner-docker-runtime driver=overlay2 data-root=/var/lib/dim/workspace-data/docker data-fstype=ext2/ext3\ninner-docker-network-ok\n'
      elif [[ "$container_name" == *-incompatible ]]; then
        exit 1
      else
        for argument in "$@"; do
          [[ "$argument" != type=bind,source=*,target=/run/dim/project-root,readonly ]] || printf '%s\n' "\${argument#type=bind,source=}" | cut -d, -f1 >"$DIM_TEST_STATE/root-$container_name"
        done
        printf '%s\n' "$container_id"
      fi
    elif [[ "$arguments" == *" /data/owned-descendant "* ]]; then
      printf '1234:2345:751\n'
    fi
    ;;
  volume)
    operation="\${1:-}"; shift || true; name="\${!#}"
    case "$operation" in
      create) : >"$DIM_TEST_STATE/volume-$name"; printf '%s\n' "$name" ;;
      inspect)
        [[ -f "$DIM_TEST_STATE/volume-$name" ]] || {
          [[ "$DIM_TEST_FAILURE" != missing-leading-blank ]] || printf '\n' >&2
          printf 'Error: No such volume: %s\n' "$name" >&2
          exit 1
        }
        [[ "$DIM_TEST_FAILURE" != volume-inspect-error ]] || { printf 'daemon API unavailable\n' >&2; exit 125; }
        verification="\${name#dim-root-replacement-data-}"
        [[ "$verification" != "$name" ]] || verification="\${name#dim-root-replacement-incompatible-}"
        [[ "$DIM_TEST_FAILURE" != volume-foreign ]] || verification=foreign
        printf '%s|%s|%s\n' "$name" "$verification" "$resource"
        ;;
      rm)
        [[ "$DIM_TEST_FAILURE" != volume-remove-error ]] || { printf 'volume removal denied\n' >&2; exit 1; }
        rm -f "$DIM_TEST_STATE/volume-$name"; printf '%s\n' "$name"
        ;;
    esac
    ;;
  container)
    operation="\${1:-}"; shift || true
    case "$operation" in
      inspect)
        name="\${!#}"
        [[ -f "$DIM_TEST_STATE/container-$name" ]] || {
          [[ "$DIM_TEST_FAILURE" != missing-leading-blank ]] || printf '\n' >&2
          printf 'Error: No such container: %s\n' "$name" >&2
          exit 1
        }
        [[ "$DIM_TEST_FAILURE" != container-inspect-error ]] || { printf 'daemon API unavailable\n' >&2; exit 125; }
        verification="\${name#dim-inner-smoke-}"
        [[ "$verification" != "$name" ]] || { verification="\${name#dim-root-replacement-}"; verification="\${verification%-incompatible}"; }
        [[ "$DIM_TEST_FAILURE" != container-foreign ]] || verification=foreign
        printf '%s|%s|%s\n' "$container_id" "$verification" "$resource"
        ;;
      rm)
        [[ "$DIM_TEST_FAILURE" != container-remove-error ]] || { printf 'container removal denied\n' >&2; exit 1; }
        rm -f "$DIM_TEST_STATE"/container-*; printf '%s\n' "$container_id"
        ;;
    esac
    ;;
  inspect)
    name="\${!#}"
    if [[ "$name" == dim-inner-smoke-* ]]; then
      verification="\${name#dim-inner-smoke-}"; printf 'dim-root-replacement-data-%s|true\n' "$verification"
    else
      root="$(<"$DIM_TEST_STATE/root-$name")"; printf '%s|false\n' "$root"
    fi
    ;;
  exec)
    if [[ "$arguments" == *" cat /run/dim/project-root/sentinel "* ]]; then
      name="\${1}"; root="$(<"$DIM_TEST_STATE/root-$name")"; cat "$root/sentinel"
    elif [[ "$arguments" == *" cached-inner-execution-ok "* ]]; then
      printf 'cached-inner-execution-ok'
    fi
    ;;
  logs) printf 'workspace data root is populated with incompatible ownership\n' ;;
esac
`, { mode: 0o700 });
  await chmod(resolve(tools, "docker"), 0o700);
  return { log, root, smoke: fixtureSmoke, state };
}

function runFixture(fixture: Fixture, failure: string): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [fixture.smoke], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      DIM_TEST_FAILURE: failure,
      DIM_TEST_LOG: fixture.log,
      DIM_TEST_STATE: fixture.state,
      PATH: `${resolve(fixture.root, "tools")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    timeout: 10_000,
  });
}

async function resourceState(fixture: Fixture): Promise<readonly string[]> {
  return (await readdir(fixture.state)).filter((entry) => entry.startsWith("container-") || entry.startsWith("volume-"));
}

describe("container inner Docker smoke", () => {
  it("launches every full inner-Docker lane with the production data and daemon contract", () => {
    // Given
    const productionFlags = runtimeBackends.match(/const nestedDockerFlags = "([^"]+)";/)?.[1];

    // When
    const smokeFlags = smoke.match(/^dockerd_flags="([^"]+)"$/m)?.[1];
    const fullSmoke = smoke.slice(smoke.indexOf("run_inner_smoke()"), smoke.indexOf("start_outer()"));

    // Then
    expect(productionFlags).toBe("--feature containerd-snapshotter=false");
    expect(smokeFlags).toBe(productionFlags);
    expect(smoke).not.toContain("--storage-driver=");
    expect(smoke).toContain('expected_driver="overlay2"');
    expect(fullSmoke).toContain('--mount "type=volume,source=$data_volume,target=/var/lib/dim/workspace-data"');
    expect(fullSmoke).toContain('--env "DIM_DOCKERD_FLAGS=$dockerd_flags"');
    expect(fullSmoke).toContain("{{.DockerRootDir}}");
    expect(fullSmoke).toContain("/var/lib/dim/workspace-data/docker");
  });

  it("retains execution, network, cache, persistence, and ownership-scoped cleanup evidence", () => {
    // Given
    const requiredContracts = [
      "docker run --pull=never --rm",
      "inner-docker-network-ok",
      'docker image inspect "$inner_image"',
      "/data/owned-descendant",
      "/run/dim/project-root/sentinel",
      "org.dim.verification=$verification_id",
      "org.dim.resource=container-inner-docker-smoke",
    ];

    // When
    const missingContracts = requiredContracts.filter((contract) => !smoke.includes(contract));

    // Then
    expect(missingContracts).toEqual([]);
    expect(smoke).toContain("remove_owned_container");
    expect(smoke).toContain("remove_owned_volume");
    expect(smoke).toContain('docker container rm --force "$id"');
    expect(smoke).toContain('docker volume rm "$name"');
    expect(smoke).not.toContain('docker container rm --force "$outer_name"');
    expect(smoke).not.toContain('docker volume rm --force "$data_volume"');
  });

  it("publishes success only after normal owned cleanup completes", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runFixture(fixture, "none");

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("container-inner-docker-smoke-ok");
    expect(await resourceState(fixture)).toEqual([]);
  });

  it("accepts Docker 29 missing-resource diagnostics with a leading blank line", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runFixture(fixture, "missing-leading-blank");

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("container-inner-docker-smoke-ok");
    expect(await resourceState(fixture)).toEqual([]);
  });

  it("preserves the original failure status after successful trap cleanup", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runFixture(fixture, "original-failure");

    // Then
    expect(result.status).toBe(42);
    expect(result.stdout).not.toContain("container-inner-docker-smoke-ok");
    expect(await resourceState(fixture)).toEqual([]);
  });

  it.each([
    "container-inspect-error",
    "container-remove-error",
    "container-foreign",
    "volume-inspect-error",
    "volume-remove-error",
    "volume-foreign",
  ])("fails without publishing success or deleting the retained resource on %s", async (failure) => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runFixture(fixture, failure);
    const commands = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("container-inner-docker-smoke-ok");
    expect(await resourceState(fixture)).not.toEqual([]);
    if (failure === "container-foreign") expect(commands).not.toContain("container rm --force");
    if (failure === "volume-foreign") expect(commands).not.toContain("volume rm");
  });
});
