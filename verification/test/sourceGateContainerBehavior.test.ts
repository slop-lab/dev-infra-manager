import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const archivePath = resolve(workspaceRoot, "verification/source-gate/archive.bash");
const wrapperPath = resolve(workspaceRoot, "verification/scripts/source-gate-container.bash");
const imageId = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);

describe("source gate container behavior", () => {
  it("omits conventional credential sentinels while retaining reviewed source", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-source-archive-"));
    try {
      const sentinels = [
        ".git-credentials", ".netrc", ".docker/config.json", ".ssh/id_ed25519",
        "nested/.git-credentials", "nested/.netrc", "nested/.docker/config.json", "nested/.ssh/id_ed25519"
      ];
      await Promise.all(sentinels.map(async (path) => {
        const target = resolve(root, path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, `secret:${path}\n`);
      }));
      await writeFile(resolve(root, "reviewed.txt"), "reviewed\n");

      // When
      const archive = spawnSync("bash", [archivePath, root]);
      const listing = spawnSync("tar", ["--list", "--file", "-"], { input: archive.stdout, encoding: "utf8" });

      // Then
      expect(archive.status, archive.stderr.toString()).toBe(0);
      expect(listing.status, listing.stderr).toBe(0);
      expect(listing.stdout).toContain("./reviewed.txt");
      for (const sentinel of sentinels) expect(listing.stdout).not.toContain(sentinel);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes host group and other write bits without removing reviewed executable bits", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-source-modes-"));
    const extracted = await mkdtemp(resolve(tmpdir(), "dim-source-modes-extracted-"));
    try {
      await writeFile(resolve(root, "executable.bash"), "#!/usr/bin/env bash\n");
      await writeFile(resolve(root, "regular.txt"), "reviewed\n");
      await chmod(resolve(root, "executable.bash"), 0o775);
      await chmod(resolve(root, "regular.txt"), 0o664);

      // When
      const archive = spawnSync("bash", [archivePath, root]);
      const extraction = spawnSync("tar", ["--extract", "--file", "-", "--directory", extracted], {
        input: archive.stdout,
        encoding: "utf8"
      });

      // Then
      expect(archive.status, archive.stderr.toString()).toBe(0);
      expect(extraction.status, extraction.stderr).toBe(0);
      expect((await stat(resolve(extracted, "executable.bash"))).mode & 0o777).toBe(0o755);
      expect((await stat(resolve(extracted, "regular.txt"))).mode & 0o777).toBe(0o644);
    } finally {
      await Promise.all([root, extracted].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it("runs the normalized immutable build ID and removes its owned container", async () => {
    // Given
    const fixture = await fakeDockerFixture(false);
    try {
      // When
      const result = runWrapper(fixture);
      const log = await readFile(fixture.log, "utf8");

      // Then
      expect(result.status, result.stderr).toBe(0);
      expect(log).toMatch(new RegExp(`^run\\t.*${imageId}$`, "m"));
      expect(log).toMatch(/^run\t.*\t--cpus\t2\t/m);
      expect(log).toContain(`container\trm\t--force\t${containerId}`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["24", "26"])("builds and checks the requested Node.js %s lane", async (major) => {
    const fixture = await fakeDockerFixture(false);
    try {
      const result = runWrapper(fixture, major);
      const log = await readFile(fixture.log, "utf8");
      expect(result.status, result.stderr).toBe(0);
      expect(log).toContain(`build\t--target\tsource-node-${major}\t--iidfile`);
      expect(log).toContain(`exec\t--env\tDIM_SOURCE_NODE_MAJOR=${major}\t`);
      expect(result.stdout).toContain(`source-gate Node.js lane: ${major}`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["22", "latest", "26 --privileged"])("rejects unsupported lane %s before Docker runs", async (major) => {
    const fixture = await fakeDockerFixture(false);
    try {
      const result = runWrapper(fixture, major);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("DIM_SOURCE_NODE_MAJOR must be 24 or 26");
      await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("exports failed gate logs before removing the owned container", async () => {
    const fixture = await fakeDockerFixture(false);
    try {
      const result = runWrapper(fixture, "24", [], { DIM_FAKE_GATE_FAILURE: "1", DIM_CHECK_VERBOSE: "1" });
      expect(result.status).toBe(23);
      expect(result.stderr).toContain("intentional gate failure");
      const log = await readFile(fixture.log, "utf8");
      expect(log).toContain("DIM_CHECK_VERBOSE=1");
      const exportAt = log.indexOf(`${containerId}:/tmp/dim-source-checks`);
      const removeAt = log.indexOf(`container\trm\t--force\t${containerId}`);
      expect(exportAt).toBeGreaterThan(-1);
      expect(removeAt).toBeGreaterThan(exportAt);
      const [run] = await readdir(resolve(fixture.root, "checks"));
      expect(await readFile(resolve(fixture.root, "checks", run!, "container/failure.log"), "utf8")).toContain("failed-stage-detail");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("preserves a foreign replacement even when inspect output has trailing newlines", async () => {
    // Given
    const fixture = await fakeDockerFixture(true);
    try {
      // When
      const result = runWrapper(fixture);
      const log = await readFile(fixture.log, "utf8");

      // Then
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("preserving source-gate container with foreign or malformed ownership");
      expect(log).not.toContain("container\trm\t--force");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

type FakeDockerFixture = {
  readonly root: string;
  readonly tools: string;
  readonly log: string;
  readonly foreign: boolean;
};

async function fakeDockerFixture(foreign: boolean): Promise<FakeDockerFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-source-docker-"));
  const tools = resolve(root, "tools");
  const log = resolve(root, "docker.log");
  await mkdir(tools);
  await writeFile(resolve(tools, "docker"), `#!/usr/bin/env bash
set -euo pipefail
command="$1"
printf '%s' "$command" >>"$DIM_FAKE_DOCKER_LOG"
shift
printf '\\t%s' "$@" >>"$DIM_FAKE_DOCKER_LOG"
printf '\\n' >>"$DIM_FAKE_DOCKER_LOG"
case "$command" in
  build)
    while (( $# > 0 )); do
      if [[ "$1" == --iidfile ]]; then printf '${imageId}\\n\\n' >"$2"; exit 0; fi
      shift
    done
    exit 1
    ;;
  run) printf '${containerId}\\n' ;;
  exec)
    if [[ "\${DIM_FAKE_GATE_FAILURE:-}" == 1 && " $* " == *" /usr/local/bin/dim-source-gate-run "* ]]; then
      printf 'intentional gate failure\\n' >&2
      exit 23
    fi
    exit 0 ;;

  container)
    case "$1" in
      cp)
        if [[ "$2" == - ]]; then cat >/dev/null
        else mkdir -p "$3"; printf 'failed-stage-detail\\n' >"$3/failure.log"; fi
        ;;
      inspect)
        owner="${foreign ? "foreign" : "${@: -1}"}"
        printf '${containerId}|%s|source-gate\\n\\n' "$owner"
        ;;
      rm) printf '%s\\n\\n' "\${@: -1}" ;;
    esac
    ;;
esac
`);
  await chmod(resolve(tools, "docker"), 0o755);
  return { root, tools, log, foreign };
}

function runWrapper(fixture: FakeDockerFixture, major = "24", args: string[] = ["true"], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [wrapperPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DIM_SOURCE_NODE_MAJOR: major,
      PATH: `${fixture.tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      DIM_FAKE_DOCKER_LOG: fixture.log,
      DIM_CHECK_LOG_DIR: resolve(fixture.root, "checks"),
      ...extraEnv
    }
  });
}
