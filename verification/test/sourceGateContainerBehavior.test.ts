import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      expect(log).toContain(`container\trm\t--force\t${containerId}`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
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
  exec) exit 0 ;;
  container)
    case "$1" in
      cp) cat >/dev/null ;;
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

function runWrapper(fixture: FakeDockerFixture) {
  return spawnSync("bash", [wrapperPath, "true"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      DIM_FAKE_DOCKER_LOG: fixture.log
    }
  });
}
