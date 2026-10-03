import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceBuildFixture,
  fixtureLockfile,
  fixtureRootCommit,
  runSourceBuild,
  type SourceBuildFixture
} from "./localSourceBuildPolicy.fixture.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = process.env.DIM_TEST_ROOT_REPOSITORY ?? workspaceRoot;
const fixtureRoots: string[] = [];

const sourceCommit = { DIM_SOURCE_ROOT_COMMIT: fixtureRootCommit } as const;

const publishPackageVersionHelpers = [
  resolve(import.meta.dirname, "../../core/scripts/publish-package-version.mjs"),
  resolve(import.meta.dirname, "../../plugin-dns-cloudflare/scripts/publish-package-version.mjs"),
  resolve(import.meta.dirname, "../../plugin-external-urls/scripts/publish-package-version.mjs")
] as const;

async function sourceBuildFixture(): Promise<SourceBuildFixture> {
  const fixture = await createSourceBuildFixture();
  fixtureRoots.push(fixture.root);
  return fixture;
}

type Fixture = {
  readonly root: string;
  readonly scripts: string;
  readonly tools: string;
  readonly log: string;
  readonly readiness: string;
  readonly imageState: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-local-source-policy-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const log = resolve(root, "invocations.log");
  const readiness = resolve(root, ".local/prepared-local.state");
  const imageState = resolve(root, "final-image-id");
  await mkdir(scripts, { recursive: true });
  await mkdir(tools, { recursive: true });
  await Promise.all(
    ["prepare-source-build.bash", "install-source-build.bash", "build-workspace-image.bash", "local-package-version.bash"].map(
      (script) => copyFile(resolve(projectRoot, "scripts", script), resolve(scripts, script))
    )
  );
  await writeFile(
    resolve(scripts, "pack-source-build.bash"),
    `#!/usr/bin/env bash
printf 'pack %s\\n' "$1" >>"$DIM_INVOCATIONS"
mkdir -p "$1"
mkdir -p "$DIM_SOURCE_BUILD_ROOT"
cat >"$1/packages.json" <<'JSON'
{"schemaVersion":1,"packages":[
  {"name":"@slop-lab/dim-cli","version":"0.9.0-local-${"a".repeat(64)}","file":"cli.tgz"},
  {"name":"@slop-lab/dim-installer","version":"0.9.0-local-${"a".repeat(64)}","file":"slop-lab-dim-installer-local.tgz"}
]}
JSON
touch "$1/cli.tgz"
touch "$1/slop-lab-dim-installer-local.tgz"
`
  );
  await writeFile(
    resolve(scripts, "local-preparation-state.bash"),
    "#!/usr/bin/env bash\ncount_file=\"$DIM_STATE_COUNT\"\ncount=$(( $(cat \"$count_file\" 2>/dev/null || printf 0) + 1 ))\nprintf '%s' \"$count\" >\"$count_file\"\nprintf 'state %s %s\\n' \"$DIM_LOCAL_IMAGE_INSPECT_REF\" \"$DIM_LOCAL_IMAGE_RECORD_REF\" >>\"$DIM_INVOCATIONS\"\nif [[ \"$count\" -eq 1 ]]; then printf '%s\\n' \"${DIM_STATE_FIRST:-state=fresh}\"; else printf '%s\\n' \"${DIM_STATE_SECOND:-state=fresh}\"; fi\n"
  );
  const toolsSource: Readonly<Record<string, string>> = {
    docker: `#!/usr/bin/env bash
{ printf 'docker'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "$1 $2" == 'buildx build' && "\${DIM_BUILD_FAILURE:-0}" == 1 ]]; then exit 42; fi
if [[ "$1 $2" == 'image inspect' ]]; then
  image_ref="\${!#}"
  if [[ "$image_ref" == dev-infra-project-workspace:prepare-* ]]; then
    printf 'sha256:%064d\n' 1
  elif [[ "$image_ref" == dev-infra-project-workspace:rollback-* && -f "$DIM_DOCKER_ROLLBACK_ID_FILE" ]]; then
    cat "$DIM_DOCKER_ROLLBACK_ID_FILE"
  elif [[ "\${DIM_FOREIGN_FINAL_INSPECT:-0}" == 1 && "$image_ref" == dev-infra-project-workspace:0.9.0-local-* && "$(cat "$DIM_DOCKER_FINAL_ID_FILE" 2>/dev/null)" == "$(printf 'sha256:%064d' 1)" ]]; then
    printf 'sha256:%064d\n' 3 >"$DIM_DOCKER_FINAL_ID_FILE"
    cat "$DIM_DOCKER_FINAL_ID_FILE"
  elif [[ -f "$DIM_DOCKER_FINAL_ID_FILE" ]]; then
    cat "$DIM_DOCKER_FINAL_ID_FILE"
  else
    exit 1
  fi
elif [[ "$1 $2" == 'image tag' ]]; then
  if [[ "$4" == dev-infra-project-workspace:rollback-* ]]; then
    cat "$DIM_DOCKER_FINAL_ID_FILE" >"$DIM_DOCKER_ROLLBACK_ID_FILE"
  elif [[ "\${DIM_IMAGE_RESTORE_FAILURE:-0}" == 1 && "$3" == dev-infra-project-workspace:rollback-* ]]; then
    exit 45
  elif [[ "$3" == dev-infra-project-workspace:prepare-* ]]; then
    printf 'sha256:%064d\n' 1 >"$DIM_DOCKER_FINAL_ID_FILE"
    if [[ "\${DIM_FINAL_TAG_FAILURE_AFTER_MUTATION:-0}" == 1 ]]; then exit 46; fi
  elif [[ "$3" == dev-infra-project-workspace:rollback-* ]]; then
    cat "$DIM_DOCKER_ROLLBACK_ID_FILE" >"$DIM_DOCKER_FINAL_ID_FILE"
  else
    printf '%s\n' "$3" >"$DIM_DOCKER_FINAL_ID_FILE"
  fi
elif [[ "$1 $2" == 'image rm' ]]; then
  if [[ "$3" == dev-infra-project-workspace:rollback-* ]]; then
    rm -f "$DIM_DOCKER_ROLLBACK_ID_FILE"
  elif [[ "$3" != dev-infra-project-workspace:prepare-* ]]; then
    rm -f "$DIM_DOCKER_FINAL_ID_FILE"
  fi
fi
`,
    dim: "#!/usr/bin/env bash\n{ printf 'dim'; printf ' %s' \"$@\"; printf '\\n'; } >>\"$DIM_INVOCATIONS\"\n",
    flock:
      "#!/usr/bin/env bash\nfd=\"${!#}\"\nprintf 'lock %s\\n' \"$(readlink \"/proc/$PPID/fd/$fd\")\" >>\"$DIM_INVOCATIONS\"\n",
    id: "#!/usr/bin/env bash\ncase \"$1\" in -u) printf '1234\\n' ;; -g) printf '5678\\n' ;; esac\n",
    mv: `#!/usr/bin/env bash
{ printf 'mv'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "\${DIM_READINESS_MOVE_FAILURE:-0}" == 1 && "$2" == */readiness && "$3" == */prepared-local.state ]]; then exit 42; fi
if [[ "\${DIM_FOREIGN_RETAG_ON_READINESS_FAILURE:-0}" == 1 && "$2" == */readiness && "$3" == */prepared-local.state ]]; then
  printf 'sha256:%064d\n' 3 >"$DIM_DOCKER_FINAL_ID_FILE"
  exit 42
fi
if [[ "\${DIM_PACKAGE_RESTORE_FAILURE:-0}" == 1 && "$2" == */previous-packages && "$3" == */dim-packages ]]; then exit 43; fi
if [[ "\${DIM_READINESS_RESTORE_FAILURE:-0}" == 1 && "$2" == */previous-readiness && "$3" == */prepared-local.state ]]; then exit 44; fi
exec /usr/bin/mv "$@"
`,
    node: `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    npm: `#!/usr/bin/env bash
{ printf 'npm'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
prefix=""
for ((index=1; index <= $#; index++)); do
  if [[ "\${!index}" == "--prefix" ]]; then next=$((index + 1)); prefix="\${!next}"; fi
done
mkdir -p "$prefix/node_modules/.bin"
cat >"$prefix/node_modules/.bin/dim" <<'SCRIPT'
#!/usr/bin/env bash
{ printf 'dim'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
SCRIPT
chmod +x "$prefix/node_modules/.bin/dim"
`
  };
  await Promise.all(
    Object.entries(toolsSource).map(async ([tool, source]) => {
      const path = resolve(tools, tool);
      await writeFile(path, source);
      await chmod(path, 0o755);
    })
  );
  return { root, scripts, tools, log, readiness, imageState };
}

function runScript(fixture: Fixture, script: string, environment: Readonly<Record<string, string>> = {}): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [resolve(fixture.scripts, script)], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_INVOCATIONS: fixture.log,
      DIM_STATE_COUNT: resolve(fixture.root, "state-count"),
      DIM_DOCKER_FINAL_ID_FILE: fixture.imageState,
      DIM_DOCKER_ROLLBACK_ID_FILE: resolve(fixture.root, "rollback-image-id"),
      ...environment
    }
  });
}

async function retainedPreparationRoots(fixture: Fixture): Promise<readonly string[]> {
  const localRoot = resolve(fixture.root, ".local");
  return (await readdir(localRoot)).filter((entry) => entry.startsWith("prepare.")).map((entry) => resolve(localRoot, entry));
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local source build policy", () => {
  it("prepares one reviewed monorepo commit without cloning split repositories", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", {
      DIM_SOURCE_ROOT_COMMIT: fixtureRootCommit
    });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[source] root ${fixtureRootCommit}`);
    expect(invocations).toContain(`git -C ${fixture.root} archive --format=tar --output`);
    expect(invocations).not.toMatch(/^git (?:ls-remote|clone) /m);
  });

  it.each([
    { name: "a branch", environment: { DIM_SOURCE_ROOT_COMMIT: "main" } },
    { name: "a tag", environment: { DIM_SOURCE_ROOT_COMMIT: "v0.8.0" } },
    { name: "an abbreviated commit", environment: { DIM_SOURCE_ROOT_COMMIT: "1".repeat(12) } },
    { name: "an uppercase commit", environment: { DIM_SOURCE_ROOT_COMMIT: "A".repeat(40) } },
    { name: "the obsolete shared ref", environment: { DIM_SOURCE_REF: "main" } },
    { name: "an obsolete split commit", environment: { DIM_SOURCE_CORE_COMMIT: "1".repeat(40) } }
  ])("rejects $name commit input before package or image build execution", async ({ environment }) => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "prepare-source-build.bash", environment);
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).not.toBe(0);
    expect(invocations).not.toMatch(/^(?:pnpm|docker buildx build)/m);
  });

  it("uses the current reviewed root commit when the input is omitted", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", {});
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(invocations).toContain(`git -C ${fixture.root} rev-parse HEAD`);
    expect(invocations).not.toMatch(/^git (?:ls-remote|clone) /m);
    expect(result.stdout).toContain(`[source] root ${fixtureRootCommit}`);
  });

  it("archives the exact root commit and derives one monorepo version identity", async () => {
    // Given
    const fixture = await sourceBuildFixture();
    const changedRootCommit = { DIM_SOURCE_ROOT_COMMIT: "8".repeat(40) };
    const expectedDigest = createHash("sha256")
      .update(
        `root=${fixtureRootCommit}\naggregate-lock-sha256=${createHash("sha256").update(fixtureLockfile).digest("hex")}\n`
      )
      .digest("hex");

    // When
    const first = runSourceBuild(fixture, "pack-source-build.bash", sourceCommit);
    const firstInvocations = await readFile(fixture.log, "utf8");
    await writeFile(fixture.log, "");
    const second = runSourceBuild(fixture, "pack-source-build.bash", changedRootCommit);
    const secondInvocations = await readFile(fixture.log, "utf8");

    // Then
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toContain(`[source] root ${fixtureRootCommit}`);
    expect(firstInvocations).toContain(`archive --format=tar --output`);
    expect(firstInvocations).toContain(fixtureRootCommit);
    expect(firstInvocations).toContain(`version=0.8.0-local-${expectedDigest}`);
    expect(secondInvocations).not.toContain(`version=0.8.0-local-${expectedDigest}`);
  });

  it("copies the checked-in aggregate lock and installs the synthetic workspace frozen", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", sourceCommit);
    const invocations = await readFile(fixture.log, "utf8");
    const copiedLock = await readFile(resolve(fixture.root, "output/.packed-lock"), "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(copiedLock).toBe(fixtureLockfile);
    expect(invocations).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+ install --frozen-lockfile/m);
  });

  it.each([
    { name: "missing", removeLock: true, environment: {} },
    { name: "stale", removeLock: false, environment: { DIM_AGGREGATE_LOCK_STALE: "1" } }
  ])("rejects a $name aggregate lock before build, pack, or image publication", async (scenario) => {
    // Given
    const fixture = await sourceBuildFixture();
    const sourceManifest = await readFile(resolve(fixture.root, "core/package.json"), "utf8");
    if (scenario.removeLock) {
      await rm(resolve(fixture.root, "pnpm-lock.yaml"));
    }

    // When
    const result = runSourceBuild(fixture, "prepare-source-build.bash", { ...sourceCommit, ...scenario.environment });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).not.toBe(0);
    expect(invocations).not.toMatch(/^pnpm .* run build/m);
    expect(invocations).not.toMatch(/^node .*pack-local-packages\.mjs/m);
    expect(invocations).not.toMatch(/^docker buildx build/m);
    expect(invocations).not.toMatch(/^docker image tag/m);
    expect(await readFile(resolve(fixture.root, "core/package.json"), "utf8")).toBe(sourceManifest);
  });

  it.each(["", "-dirty"])("accepts the computed aggregate identity in every production package helper%s", (suffix) => {
    // Given
    const aggregate = createHash("sha256")
      .update(
        `root=${fixtureRootCommit}\naggregate-lock-sha256=${createHash("sha256").update(fixtureLockfile).digest("hex")}\n`
      )
      .digest("hex");
    const localVersion = `0.8.0-local-${aggregate}${suffix}`;

    // When
    const results = publishPackageVersionHelpers.map((helper) => spawnSync(process.execPath, ["--input-type=module", "--eval", `import { publishPackageVersion } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(publishPackageVersion("0.8.0", ${JSON.stringify(localVersion)}));`], { encoding: "utf8" }));

    // Then
    for (const result of results) {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(localVersion);
    }
  });

  it.each(["1", "1".repeat(40)])("rejects short identities in every production package helper: %s", (identity) => {
    // Given
    const localVersion = `0.8.0-local-${identity}`;

    // When
    const results = publishPackageVersionHelpers.map((helper) => spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { publishPackageVersion } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(publishPackageVersion("0.8.0", ${JSON.stringify(localVersion)}));`
    ], { encoding: "utf8" }));

    // Then
    for (const result of results) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DIM_LOCAL_BUILD_VERSION");
    }
  });

  it("rejects a root commit that resolves differently before dependency installation", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", {
      ...sourceCommit,
      DIM_GIT_MISMATCH_ROOT: "1"
    });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).not.toBe(0);
    expect(invocations).not.toMatch(/^pnpm /m);
  });

  it("isolates production package linking and keeps installation restart-free", async () => {
    // Given
    const packaging = await readFile(resolve(projectRoot, "scripts/pack-source-build.bash"), "utf8");
    const installation = await readFile(resolve(projectRoot, "scripts/install-source-build.bash"), "utf8");
    const recipes = await readFile(resolve(projectRoot, "justfile"), "utf8");
    const imageConsumers = await Promise.all([
      "container-sysbox-isolation-smoke.bash",
      "container-inner-docker-smoke.bash",
      "single-repository-example-smoke.bash",
      "two-repository-example-smoke.bash",
      "multi-repository-example-smoke.bash",
      "external-url-example-smoke.bash"
    ].map((script) => readFile(resolve(workspaceRoot, "verification/scripts", script), "utf8")));

    // Then
    expect(packaging).toContain('git -C "$repo_root" archive');
    expect(packaging).toContain('cat >"$source_root/pnpm-workspace.yaml"');
    expect(packaging).toContain('pnpm --dir "$source_root" install --frozen-lockfile');
    expect(packaging).toContain("aggregate-lock-sha256=%s");
    expect(installation).not.toMatch(/(?:systemctl|dim)\s+(?:restart|controller restart)/);
    expect(recipes).toContain(`build-local-workspace-image:\n    image_version="$(bash verification/scripts/local-build-version.bash)"`);
    expect(recipes).toContain("prepare-local:\n    bash scripts/prepare-source-build.bash");
    expect(recipes).toContain("install-local:\n    bash scripts/install-source-build.bash");
    expect(recipes).toContain("restart-controller:");
    expect(recipes.indexOf("install-local:")).toBeLessThan(recipes.indexOf("restart-controller:"));
    expect(imageConsumers.every((script) => script.includes('local_version="$(bash "$script_dir/local-build-version.bash")"'))).toBe(true);
    expect(imageConsumers.every((script) => script.includes("dev-infra-project-workspace:$local_version"))).toBe(true);
    expect(imageConsumers.every((script) => !script.includes("require('./core/package.json').version"))).toBe(true);
    expect(imageConsumers.every((script) => !script.includes("dev-infra-project-workspace:latest"))).toBe(true);
  });

  it("routes the aggregate local version through the source CLI workspace-image build", async () => {
    // Given
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "dim-local-workspace-recipe-"));
    fixtureRoots.push(fixtureRoot);
    const log = resolve(fixtureRoot, "invocations.log");
    const tools = resolve(fixtureRoot, "tools"); await mkdir(tools);
    await writeFile(
      resolve(tools, "just"),
      "#!/usr/bin/env bash\n  printf 'version=%s\\n' \"$DIM_LOCAL_BUILD_VERSION\" >>\"$DIM_INVOCATIONS\"\n  printf 'just' >>\"$DIM_INVOCATIONS\"\n  printf ' %s' \"$@\" >>\"$DIM_INVOCATIONS\"\n  printf '\\n' >>\"$DIM_INVOCATIONS\"\n", { mode: 0o755 }
    );
    const expectedVersion = spawnSync("/usr/bin/bash", [resolve(workspaceRoot, "verification/scripts/local-build-version.bash")], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: process.env
    });

    // When
    const result = spawnSync("/usr/local/bin/just", ["build-local-workspace-image"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DIM_INVOCATIONS: log
      }
    });
    const invocations = await readFile(log, "utf8");

    // Then
    expect(expectedVersion.status).toBe(0);
    expect(result.status).toBe(0);
    expect(invocations).toBe(`version=${expectedVersion.stdout.trim()}\njust run-cli workspace image build\n`);
    expect(invocations).not.toMatch(/(?:install|restart|latest)/);
  });

  it("publishes the final image tag only after packages and readiness", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runScript(fixture, "prepare-source-build.bash");
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(await readFile(fixture.readiness, "utf8")).toBe("state=fresh\n");
    expect(invocations).toMatch(new RegExp(`pack ${resolve(fixture.root, ".local/prepare\\.[^/]+/packages")}`));
    expect(invocations).toMatch(/docker buildx build .* --load .* --tag dev-infra-project-workspace:prepare-1234-/);
    expect(invocations.indexOf("pack ")).toBeLessThan(invocations.indexOf("docker buildx build"));
    expect(invocations.indexOf("docker buildx build")).toBeLessThan(
      invocations.indexOf("state dev-infra-project-workspace:prepare-1234-")
    );
    expect(invocations.indexOf("state dev-infra-project-workspace:prepare-1234-")).toBeLessThan(
      invocations.indexOf(`docker image tag dev-infra-project-workspace:prepare-1234-`)
    );
    expect(invocations.lastIndexOf("mv -- ")).toBeLessThan(
      invocations.indexOf(`docker image tag dev-infra-project-workspace:prepare-1234-`)
    );
    expect(invocations).toContain(
      `dev-infra-project-workspace:0.9.0-local-${"a".repeat(64)}`
    );
    expect(invocations).not.toContain("dev-infra-project-workspace:latest");
  });

  it("binds the versioned image tag to the inspected immutable image ID", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-local-image-state-"));
    fixtureRoots.push(root);
    const scripts = resolve(root, "scripts");
    const tools = resolve(root, "tools");
    const packages = resolve(root, ".local/dim-packages");
    await Promise.all([mkdir(scripts), mkdir(tools), mkdir(packages, { recursive: true })]);
    await copyFile(
      resolve(projectRoot, "scripts/local-preparation-state.bash"),
      resolve(scripts, "local-preparation-state.bash")
    );
    await writeFile(resolve(packages, "packages.json"), "{}\n");
    await writeFile(resolve(packages, "package.tgz"), "package bytes\n");
    await writeFile(
      resolve(packages, ".dim-source-state"),
      `root=${fixtureRootCommit}\naggregate-lock-sha256=${"a".repeat(64)}\n`
    );
    await writeFile(resolve(tools, "git"), `#!/usr/bin/env bash\nprintf '%040d\\n' 7\n`);
    await writeFile(resolve(tools, "docker"), `#!/usr/bin/env bash\nprintf 'sha256:%064d\\n' 8\n`);
    await Promise.all(["git", "docker"].map((tool) => chmod(resolve(tools, tool), 0o755)));
    const imageTag = `dev-infra-project-workspace:0.9.0-local-${"a".repeat(64)}`;

    // When
    const result = spawnSync("/usr/bin/bash", [resolve(scripts, "local-preparation-state.bash")], {
      encoding: "utf8",
      env: {
        PATH: `${tools}:/usr/bin:/bin`,
        DIM_LOCAL_IMAGE_INSPECT_REF: "dev-infra-project-workspace:prepare-test",
        DIM_LOCAL_IMAGE_RECORD_REF: imageTag
      }
    });

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`image.ref=${imageTag}\n`);
    expect(result.stdout).toContain(`image.id=sha256:${"0".repeat(63)}8\n`);
    expect(result.stdout).toContain(`root=${fixtureRootCommit}\n`);
    expect(result.stdout).toContain(`aggregate-lock-sha256=${"a".repeat(64)}\n`);
  });

  it("preserves the previously published candidate when staging fails", async () => {
    // Given
    const fixture = await createFixture();
    const packages = resolve(fixture.root, ".local/dim-packages");
    await mkdir(packages, { recursive: true });
    await writeFile(fixture.readiness, "state=old\n");
    await writeFile(resolve(packages, "previous-candidate"), "preserved\n");

    // When
    const result = runScript(fixture, "prepare-source-build.bash", { DIM_BUILD_FAILURE: "1" });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(42);
    expect(await readFile(fixture.readiness, "utf8")).toBe("state=old\n");
    expect(await readFile(resolve(packages, "previous-candidate"), "utf8")).toBe("preserved\n");
    expect(invocations).not.toContain("docker image tag");
    expect(invocations).not.toContain("state dev-infra-project-workspace");
  });

  it("publishes no candidate or readiness when initial staging fails", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runScript(fixture, "prepare-source-build.bash", { DIM_BUILD_FAILURE: "1" });

    // Then
    expect(result.status).toBe(42);
    await expect(readFile(fixture.readiness, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(fixture.root, ".local/dim-packages/packages.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("does not overwrite a foreign retag when readiness publication fails", async () => {
    // Given
    const fixture = await createFixture();
    const packages = resolve(fixture.root, ".local/dim-packages");
    const priorImageId = `sha256:${"2".repeat(64)}`;
    const foreignImageId = `sha256:${"0".repeat(63)}3`;
    await mkdir(packages, { recursive: true });
    await writeFile(resolve(packages, "previous-candidate"), "preserved\n");
    await writeFile(fixture.readiness, "state=old\n");
    await writeFile(fixture.imageState, `${priorImageId}\n`);

    // When
    const result = runScript(fixture, "prepare-source-build.bash", { DIM_FOREIGN_RETAG_ON_READINESS_FAILURE: "1" });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(42);
    expect(await readFile(resolve(packages, "previous-candidate"), "utf8")).toBe("preserved\n");
    expect(await readFile(fixture.readiness, "utf8")).toBe("state=old\n");
    expect((await readFile(fixture.imageState, "utf8")).trim()).toBe(foreignImageId);
    expect(invocations).not.toMatch(/docker image (?:tag|rm) .* dev-infra-project-workspace:0\.9\.0-local-a{64}/);
  });

  it("publishes no image tag or candidate when first readiness publication fails", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runScript(fixture, "prepare-source-build.bash", { DIM_READINESS_MOVE_FAILURE: "1" });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(42);
    await expect(readFile(fixture.imageState, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.readiness, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(fixture.root, ".local/dim-packages/packages.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(invocations).not.toMatch(/docker image (?:tag|rm) .* dev-infra-project-workspace:0\.9\.0-local-a{64}/);
  });

  it("retains prior packages when package restoration fails", async () => {
    // Given
    const fixture = await createFixture();
    const packages = resolve(fixture.root, ".local/dim-packages");
    await mkdir(packages, { recursive: true });
    await writeFile(resolve(packages, "previous-candidate"), "preserved\n");
    await writeFile(fixture.readiness, "state=old\n");

    // When
    const result = runScript(fixture, "prepare-source-build.bash", {
      DIM_PACKAGE_RESTORE_FAILURE: "1",
      DIM_READINESS_MOVE_FAILURE: "1"
    });
    const recoveryRoots = await retainedPreparationRoots(fixture);

    // Then
    expect(result.status).toBe(42);
    expect(recoveryRoots).toHaveLength(1);
    expect(await readFile(resolve(recoveryRoots[0]!, "previous-packages/previous-candidate"), "utf8")).toBe("preserved\n");
    expect(result.stderr).toContain(`rollback incomplete; recovery data retained at ${recoveryRoots[0]}`);
  });

  it("retains prior readiness when readiness restoration fails", async () => {
    // Given
    const fixture = await createFixture();
    const packages = resolve(fixture.root, ".local/dim-packages");
    await mkdir(packages, { recursive: true });
    await writeFile(resolve(packages, "previous-candidate"), "preserved\n");
    await writeFile(fixture.readiness, "state=old\n");

    // When
    const result = runScript(fixture, "prepare-source-build.bash", {
      DIM_READINESS_MOVE_FAILURE: "1",
      DIM_READINESS_RESTORE_FAILURE: "1"
    });
    const recoveryRoots = await retainedPreparationRoots(fixture);

    // Then
    expect(result.status).toBe(42);
    expect(recoveryRoots).toHaveLength(1);
    expect(await readFile(resolve(recoveryRoots[0]!, "previous-readiness"), "utf8")).toBe("state=old\n");
    expect(result.stderr).toContain(`rollback incomplete; recovery data retained at ${recoveryRoots[0]}`);
  });

  it("retains image recovery references when final image publication fails after mutation", async () => {
    // Given
    const fixture = await createFixture();
    const packages = resolve(fixture.root, ".local/dim-packages");
    const priorImageId = `sha256:${"2".repeat(64)}`;
    const promotedImageId = `sha256:${"0".repeat(63)}1`;
    await mkdir(packages, { recursive: true });
    await writeFile(resolve(packages, "previous-candidate"), "preserved\n");
    await writeFile(fixture.readiness, "state=old\n");
    await writeFile(fixture.imageState, `${priorImageId}\n`);

    // When
    const result = runScript(fixture, "prepare-source-build.bash", {
      DIM_FINAL_TAG_FAILURE_AFTER_MUTATION: "1",
      DIM_IMAGE_RESTORE_FAILURE: "1"
    });
    const invocations = await readFile(fixture.log, "utf8");
    const recoveryRoots = await retainedPreparationRoots(fixture);

    // Then
    expect(result.status).not.toBe(0);
    expect((await readFile(fixture.imageState, "utf8")).trim()).toBe(promotedImageId);
    expect((await readFile(resolve(fixture.root, "rollback-image-id"), "utf8")).trim()).toBe(priorImageId);
    expect(invocations).not.toMatch(/docker image (?:tag|rm) dev-infra-project-workspace:rollback-1234-\d+ dev-infra-project-workspace:0\.9\.0-local-a{64}/);
    expect(recoveryRoots).toHaveLength(1);
    expect(result.stderr).toContain("image publication requires manual recovery");
  });

  it("fails closed when the final tag inspects as a foreign image", async () => {
    // Given
    const fixture = await createFixture();
    const packages = resolve(fixture.root, ".local/dim-packages");
    const priorImageId = `sha256:${"2".repeat(64)}`;
    const foreignImageId = `sha256:${"0".repeat(63)}3`;
    await mkdir(packages, { recursive: true });
    await writeFile(resolve(packages, "previous-candidate"), "preserved\n");
    await writeFile(fixture.readiness, "state=old\n");
    await writeFile(fixture.imageState, `${priorImageId}\n`);

    // When
    const result = runScript(fixture, "prepare-source-build.bash", { DIM_FOREIGN_FINAL_INSPECT: "1" });
    const invocations = await readFile(fixture.log, "utf8");
    const recoveryRoots = await retainedPreparationRoots(fixture);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("local source build is prepared");
    expect((await readFile(fixture.imageState, "utf8")).trim()).toBe(foreignImageId);
    expect((await readFile(resolve(fixture.root, "rollback-image-id"), "utf8")).trim()).toBe(priorImageId);
    expect(await readFile(resolve(packages, "previous-candidate"), "utf8")).toBe("preserved\n");
    expect(await readFile(fixture.readiness, "utf8")).toBe("state=old\n");
    expect(invocations).not.toMatch(/docker image (?:tag|rm) dev-infra-project-workspace:rollback-1234-\d+ dev-infra-project-workspace:0\.9\.0-local-a{64}/);
    expect(invocations).not.toMatch(/docker image rm dev-infra-project-workspace:prepare-1234-\d+/);
    expect(recoveryRoots).toHaveLength(1);
    expect(result.stderr).toContain("promoted image ID does not match the prepared image");
    expect(result.stderr).toContain("image publication requires manual recovery");
  });

  it("rejects a symlinked package publication path without changing its target", async () => {
    // Given
    const fixture = await createFixture();
    const target = resolve(fixture.root, "tracked-target");
    await mkdir(resolve(fixture.root, ".local"), { recursive: true });
    await mkdir(target);
    await writeFile(resolve(target, "sentinel"), "preserved\n");
    await symlink(target, resolve(fixture.root, ".local/dim-packages"));

    // When
    const result = runScript(fixture, "prepare-source-build.bash");

    // Then
    expect(result.status).not.toBe(0);
    expect(await readFile(resolve(target, "sentinel"), "utf8")).toBe("preserved\n");
  });

  it("rejects a symlinked readiness path without changing its target", async () => {
    // Given
    const fixture = await createFixture();
    const target = resolve(fixture.root, "readiness-target");
    await mkdir(resolve(fixture.root, ".local"), { recursive: true });
    await writeFile(target, "preserved\n");
    await symlink(target, fixture.readiness);

    // When
    const result = runScript(fixture, "prepare-source-build.bash");

    // Then
    expect(result.status).not.toBe(0);
    expect(await readFile(target, "utf8")).toBe("preserved\n");
  });

  it("reports missing preparation before package-version parsing or installation", async () => {
    // Given
    const fixture = await createFixture();
    await expect(readFile(resolve(fixture.root, ".local/dim-packages/packages.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    // When
    const result = runScript(fixture, "install-source-build.bash");
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("local source build is not prepared; run just prepare-local\n");
    expect(invocations).not.toContain("dim installer install core");
    expect(invocations).not.toContain("dim controller restart");
    expect(invocations).not.toContain("pack ");
    expect(invocations).not.toContain("docker build");
  });

  it.each([
    { name: "missing", readiness: undefined, firstState: "state=fresh" },
    { name: "stale", readiness: "state=stale\n", firstState: "state=fresh" }
  ])("rejects $name preparation before install or restart", async (scenario) => {
    // Given
    const fixture = await createFixture();
    if (scenario.readiness !== undefined) {
      await mkdir(resolve(fixture.root, ".local"), { recursive: true });
      await writeFile(fixture.readiness, scenario.readiness);
    }

    // When
    const result = runScript(fixture, "install-source-build.bash", { DIM_STATE_FIRST: scenario.firstState });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(1);
    expect(invocations).not.toContain("dim installer install core");
    expect(invocations).not.toContain("dim controller restart");
    expect(invocations).not.toContain("pack ");
    expect(invocations).not.toContain("docker build");
  });

  it("installs a prepared bundle and restarts after plugin activation", async () => {
    // Given
    const fixture = await createFixture();
    expect(runScript(fixture, "prepare-source-build.bash").status).toBe(0);
    await writeFile(fixture.log, "");
    await writeFile(resolve(fixture.root, "state-count"), "0");

    // When
    const result = runScript(fixture, "install-source-build.bash");
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(invocations).toContain("dim installer install core");
    expect(invocations).toContain("dim --version");
    expect(invocations).toContain("dim controller restart");
    expect(invocations.indexOf("dim installer enable-plugin"))
      .toBeLessThan(invocations.indexOf("dim controller restart"));
    expect(invocations).toContain(
      `state dev-infra-project-workspace:0.9.0-local-${"a".repeat(64)} dev-infra-project-workspace:0.9.0-local-${"a".repeat(64)}`
    );
  });

  it("validates again after install and shares the preparation lock", async () => {
    // Given
    const fixture = await createFixture();
    expect(runScript(fixture, "prepare-source-build.bash").status).toBe(0);
    const preparationInvocations = await readFile(fixture.log, "utf8");
    await writeFile(fixture.log, "");
    await writeFile(resolve(fixture.root, "state-count"), "0");

    // When
    const result = runScript(fixture, "install-source-build.bash", {
      DIM_STATE_FIRST: "state=fresh",
      DIM_STATE_SECOND: "state=changed"
    });
    const invocations = await readFile(fixture.log, "utf8");
    const lockPath = resolve(fixture.root, ".local/prepare-install.lock");

    // Then
    expect(result.status).toBe(1);
    expect(preparationInvocations).toContain(`lock ${lockPath}`);
    expect(invocations.match(new RegExp(`lock ${lockPath}`, "g"))).toHaveLength(1);
    expect(invocations.match(/^state /gm)).toHaveLength(2);
    expect(invocations).toContain("dim installer install core");
    expect(invocations).toContain("dim controller restart");
    expect(invocations.indexOf("dim installer enable-plugin"))
      .toBeLessThan(invocations.indexOf("dim controller restart"));
    expect(invocations).not.toMatch(/^pack /m);
    expect(invocations).not.toContain("docker build");
  });
});
