import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");

export const fixturePackageManifest = '{"name":"fixture-package","version":"0.8.0"}\n';
export const fixtureLockfile = "lockfileVersion: '9.0'\n";

export type SourceBuildFixture = {
  readonly root: string;
  readonly tools: string;
  readonly log: string;
};

export async function createSourceBuildFixture(): Promise<SourceBuildFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-source-commit-policy-"));
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const log = resolve(root, "invocations.log");
  await mkdir(scripts, { recursive: true });
  await mkdir(tools, { recursive: true });
  await Promise.all(
    ["pack-source-build.bash", "prepare-source-build.bash", "build-workspace-image.bash", "local-package-version.bash"].map((script) =>
      copyFile(resolve(workspaceRoot, "project/scripts", script), resolve(scripts, script))
    )
  );
  await writeFile(resolve(scripts, "pack-local-packages.mjs"), "");

  const toolsSource: Readonly<Record<string, string>> = {
    docker:
      "#!/usr/bin/env bash\n{ printf 'docker'; printf ' %s' \"$@\"; printf '\\n'; } >>\"$DIM_INVOCATIONS\"\n",
    flock: "#!/usr/bin/env bash\nexit 0\n",
    git: [
      "#!/usr/bin/env bash",
      "{ printf 'git'; printf ' %s' \"$@\"; printf '\\n'; } >>\"$DIM_INVOCATIONS\"",
      "if [[ \"$1\" == '-C' ]]; then",
      "  directory=\"$2\"",
      "  shift 2",
      "  case \"$1 $2 $3\" in",
      "    'remote get-url origin') printf '%s\\n' '/fixtures/root.git' ;;",
      "    'fetch --quiet origin') ;;",
      "    'checkout --quiet --detach') printf '%s\\n' \"$4\" >\"$directory/.head\" ;;",
      "    'rev-parse HEAD ')",
      "      if [[ \"$(basename \"$directory\")\" == \"${DIM_GIT_MISMATCH_REPOSITORY:-}\" ]]; then",
      "        printf '%040d\\n' 9",
      "      else",
      "        cat \"$directory/.head\"",
      "      fi",
      "      ;;",
      "    'status --porcelain ') ;;",
      "    *) exit 91 ;;",
      "  esac",
      "elif [[ \"$1\" == 'ls-remote' ]]; then",
      "  case \"$2\" in",
      "    */core.git) printf '%040d\\tHEAD\\n' 1 ;;",
      "    */plugin-dns-cloudflare.git) printf '%040d\\tHEAD\\n' 2 ;;",
      "    */plugin-external-urls.git) printf '%040d\\tHEAD\\n' 3 ;;",
      "    *) exit 93 ;;",
      "  esac",
      "elif [[ \"$1\" == 'clone' ]]; then",
      "  directory=\"${!#}\"",
      "  mkdir -p \"$directory\"",
      `  printf '%s\\n' '${fixturePackageManifest.trimEnd()}' >"$directory/package.json"`,
      `  printf '%s\\n' "${fixtureLockfile.trimEnd()}" >"$directory/pnpm-lock.yaml"`,
      "else",
      "  exit 92",
      "fi",
      ""
    ].join("\n"),
    id: "#!/usr/bin/env bash\nprintf '1234\n'\n",
    node: [
      "#!/usr/bin/env bash",
      "if [[ \"$1\" == '-p' ]]; then",
      "  printf '0.8.0\\n'",
      "else",
      "  [[ -f \"$1\" ]] || exit 44",
      "  source_root=\"$(dirname \"$(dirname \"$1\")\")/.local/production-source\"",
      "  [[ -f \"$source_root/plugin-dns-cloudflare/.built\" ]] || exit 45",
      "  [[ -f \"$source_root/plugin-external-urls/.built\" ]] || exit 46",
      "  printf 'node %s version=%s\\n' \"$*\" \"${DIM_LOCAL_BUILD_VERSION:-unset}\" >>\"$DIM_INVOCATIONS\"",
      "fi",
      ""
    ].join("\n"),
    pnpm: [
      "#!/usr/bin/env bash",
      "printf 'pnpm %s version=%s\\n' \"$*\" \"${DIM_LOCAL_BUILD_VERSION:-unset}\" >>\"$DIM_INVOCATIONS\"",
      "[[ \"$1\" == '--dir' ]] || exit 81",
      "directory=\"$2\"",
      "command=\"$3\"",
      "if [[ \"$command\" == 'install' ]]; then",
      "  [[ \"$4\" == '--lockfile=false' ]] || exit 82",
      "  [[ \"${DIM_WORKSPACE_INSTALL_FAILURE:-0}\" == 0 ]] || exit 42",
      "  for plugin in plugin-dns-cloudflare plugin-external-urls; do",
      "    mkdir -p \"$directory/$plugin/node_modules/@slop-lab\"",
      "    ln -s \"$directory/core/packages/core\" \"$directory/$plugin/node_modules/@slop-lab/dim-core\"",
      "    ln -s \"$directory/core/packages/contracts/external-url\" \"$directory/$plugin/node_modules/@slop-lab/dim-contracts-external-url\"",
      "  done",
      "elif [[ \"$command $4\" == 'run build' ]]; then",
      "  if [[ \"$(basename \"$directory\")\" == 'core' ]]; then",
      "    mkdir -p \"$directory/packages/core/dist\" \"$directory/packages/contracts/external-url/dist\"",
      "    printf 'selected-unreleased-api\\n' >\"$directory/packages/core/dist/api\"",
      "    printf 'selected-unreleased-api\\n' >\"$directory/packages/contracts/external-url/dist/api\"",
      "  else",
      "    [[ \"$(cat \"$directory/node_modules/@slop-lab/dim-core/dist/api\")\" == 'selected-unreleased-api' ]] || exit 84",
      "    [[ \"$(cat \"$directory/node_modules/@slop-lab/dim-contracts-external-url/dist/api\")\" == 'selected-unreleased-api' ]] || exit 85",
      "    touch \"$directory/.built\"",
      "  fi",
      "else",
      "  exit 86",
      "fi",
      ""
    ].join("\n")
  };
  await Promise.all(
    Object.entries(toolsSource).map(async ([tool, source]) => {
      const path = resolve(tools, tool);
      await writeFile(path, source);
      await chmod(path, 0o755);
    })
  );
  return { root, tools, log };
}

export function runSourceBuild(
  fixture: SourceBuildFixture,
  script: "pack-source-build.bash" | "prepare-source-build.bash",
  environment: NodeJS.ProcessEnv
): SpawnSyncReturns<string> {
  const arguments_ = script === "pack-source-build.bash" ? [resolve(fixture.root, "output")] : [];
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts", script), ...arguments_], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_INVOCATIONS: fixture.log,
      ...environment
    }
  });
}
