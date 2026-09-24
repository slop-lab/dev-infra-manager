import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceBuildFixture,
  fixtureLockfile,
  runSourceBuild,
  type SourceBuildFixture
} from "./localSourceBuildPolicy.fixture.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = process.env.DIM_TEST_ROOT_REPOSITORY ?? resolve(workspaceRoot, "project");
const fixtureRoots: string[] = [];

const commits = {
  DIM_SOURCE_CORE_COMMIT: "1".repeat(40),
  DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT: "2".repeat(40),
  DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT: "3".repeat(40)
} as const;

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
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-local-source-policy-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const log = resolve(root, "invocations.log");
  const readiness = resolve(root, ".local/prepared-local.state");
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
    docker:
      "#!/usr/bin/env bash\n{ printf 'docker'; printf ' %s' \"$@\"; printf '\\n'; } >>\"$DIM_INVOCATIONS\"\nif [[ \"$1 $2\" == 'buildx build' && \"${DIM_BUILD_FAILURE:-0}\" == 1 ]]; then exit 42; fi\nif [[ \"$1 $2\" == 'image inspect' ]]; then printf 'sha256:%064d\\n' 1; fi\n",
    dim: "#!/usr/bin/env bash\n{ printf 'dim'; printf ' %s' \"$@\"; printf '\\n'; } >>\"$DIM_INVOCATIONS\"\n",
    flock:
      "#!/usr/bin/env bash\nfd=\"${!#}\"\nprintf 'lock %s\\n' \"$(readlink \"/proc/$PPID/fd/$fd\")\" >>\"$DIM_INVOCATIONS\"\n",
    id: "#!/usr/bin/env bash\ncase \"$1\" in -u) printf '1234\\n' ;; -g) printf '5678\\n' ;; esac\n",
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
  return { root, scripts, tools, log, readiness };
}

function runScript(fixture: Fixture, script: string, environment: Readonly<Record<string, string>> = {}): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [resolve(fixture.scripts, script)], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_INVOCATIONS: fixture.log,
      DIM_STATE_COUNT: resolve(fixture.root, "state-count"),
      ...environment
    }
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local source build policy", () => {
  it.each([
    { name: "a branch", environment: { ...commits, DIM_SOURCE_CORE_COMMIT: "main" } },
    { name: "a tag", environment: { ...commits, DIM_SOURCE_CORE_COMMIT: "v0.8.0" } },
    { name: "an abbreviated commit", environment: { ...commits, DIM_SOURCE_CORE_COMMIT: "1".repeat(12) } },
    { name: "an uppercase commit", environment: { ...commits, DIM_SOURCE_CORE_COMMIT: "A".repeat(40) } },
    { name: "the obsolete shared ref", environment: { ...commits, DIM_SOURCE_REF: "main" } }
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

  it("resolves omitted inputs once and verifies the resulting exact commits", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", {});
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    const resolvedCoreCommit = `${"0".repeat(39)}1`;
    expect(result.status).toBe(0);
    expect(invocations.match(/^git ls-remote /gm)).toHaveLength(3);
    expect(invocations).toContain(`fetch --quiet origin ${resolvedCoreCommit}`);
    expect(result.stdout).toContain(`[source] core ${resolvedCoreCommit}`);
  });

  it("fetches exact commits, verifies detached HEADs, and derives version identity from every repository", async () => {
    // Given
    const fixture = await sourceBuildFixture();
    const changedPluginCommits = { ...commits, DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT: "4".repeat(40) };
    const expectedDigest = createHash("sha256")
      .update(
        `core=${commits.DIM_SOURCE_CORE_COMMIT}\nplugin-dns-cloudflare=${commits.DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT}\nplugin-external-urls=${commits.DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT}\naggregate-lock-sha256=${createHash("sha256").update(fixtureLockfile).digest("hex")}\n`
      )
      .digest("hex");

    // When
    const first = runSourceBuild(fixture, "pack-source-build.bash", commits);
    const firstInvocations = await readFile(fixture.log, "utf8");
    await writeFile(fixture.log, "");
    const second = runSourceBuild(fixture, "pack-source-build.bash", changedPluginCommits);
    const secondInvocations = await readFile(fixture.log, "utf8");

    // Then
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toContain(`[source] core ${commits.DIM_SOURCE_CORE_COMMIT}`);
    expect(firstInvocations).toContain(`fetch --quiet origin ${commits.DIM_SOURCE_CORE_COMMIT}`);
    expect(firstInvocations).toContain(`checkout --quiet --detach ${commits.DIM_SOURCE_CORE_COMMIT}`);
    expect(firstInvocations).toContain(`version=0.8.0-local-${expectedDigest}`);
    expect(secondInvocations).not.toContain(`version=0.8.0-local-${expectedDigest}`);
  });

  it("copies the checked-in aggregate lock and installs the synthetic workspace frozen", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", commits);
    const invocations = await readFile(fixture.log, "utf8");
    const copiedLock = await readFile(resolve(fixture.root, ".local/production-source/pnpm-lock.yaml"), "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(copiedLock).toBe(fixtureLockfile);
    expect(invocations).toContain(`pnpm --dir ${resolve(fixture.root, ".local/production-source")} install --frozen-lockfile`);
  });

  it("changes aggregate identity when only the checked-in lock changes", async () => {
    // Given
    const fixture = await sourceBuildFixture();
    const originalLockDigest = createHash("sha256").update(fixtureLockfile).digest("hex");
    const originalIdentity = createHash("sha256")
      .update(
        `core=${commits.DIM_SOURCE_CORE_COMMIT}\nplugin-dns-cloudflare=${commits.DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT}\nplugin-external-urls=${commits.DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT}\naggregate-lock-sha256=${originalLockDigest}\n`
      )
      .digest("hex");

    // When
    const first = runSourceBuild(fixture, "pack-source-build.bash", commits);
    await writeFile(fixture.log, "");
    await writeFile(resolve(fixture.root, "pnpm-lock.yaml"), `${fixtureLockfile}settings:\n  autoInstallPeers: false\n`);
    const second = runSourceBuild(fixture, "pack-source-build.bash", commits);
    const secondInvocations = await readFile(fixture.log, "utf8");

    // Then
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(secondInvocations).not.toContain(`version=0.8.0-local-${originalIdentity}`);
  });

  it.each([
    { name: "missing", removeLock: true, environment: {} },
    { name: "stale", removeLock: false, environment: { DIM_AGGREGATE_LOCK_STALE: "1" } }
  ])("rejects a $name aggregate lock before build, pack, or image publication", async (scenario) => {
    // Given
    const fixture = await sourceBuildFixture();
    if (scenario.removeLock) {
      await rm(resolve(fixture.root, "pnpm-lock.yaml"));
    }

    // When
    const result = runSourceBuild(fixture, "prepare-source-build.bash", { ...commits, ...scenario.environment });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).not.toBe(0);
    expect(invocations).not.toMatch(/^pnpm .* run build/m);
    expect(invocations).not.toMatch(/^node .*pack-local-packages\.mjs/m);
    expect(invocations).not.toMatch(/^docker buildx build/m);
    expect(invocations).not.toMatch(/^docker image tag/m);
  });

  it.each(["", "-dirty"])("accepts the computed aggregate identity in every production package helper%s", (suffix) => {
    // Given
    const aggregate = createHash("sha256")
      .update(
        `core=${commits.DIM_SOURCE_CORE_COMMIT}\nplugin-dns-cloudflare=${commits.DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT}\nplugin-external-urls=${commits.DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT}\naggregate-lock-sha256=${createHash("sha256").update(fixtureLockfile).digest("hex")}\n`
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

  it("rejects a checkout whose full HEAD differs before dependency installation", async () => {
    // Given
    const fixture = await sourceBuildFixture();

    // When
    const result = runSourceBuild(fixture, "pack-source-build.bash", {
      ...commits,
      DIM_GIT_MISMATCH_REPOSITORY: "plugin-dns-cloudflare"
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
    expect(packaging).toContain('cat >"$source_root/pnpm-workspace.yaml"');
    expect(packaging).toContain('cp -- "$aggregate_lock" "$source_root/pnpm-lock.yaml"');
    expect(packaging).toContain('pnpm --dir "$source_root" install --frozen-lockfile');
    expect(packaging).toContain("aggregate-lock-sha256=%s");
    expect(installation).not.toMatch(/(?:systemctl|dim)\s+(?:restart|controller restart)/);
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
    const bashEnvironment = resolve(fixtureRoot, "bash-environment");
    await writeFile(
      bashEnvironment,
      "just() {\n  printf 'version=%s\\n' \"$DIM_LOCAL_BUILD_VERSION\" >>\"$DIM_INVOCATIONS\"\n  printf 'just' >>\"$DIM_INVOCATIONS\"\n  printf ' %s' \"$@\" >>\"$DIM_INVOCATIONS\"\n  printf '\\n' >>\"$DIM_INVOCATIONS\"\n}\n"
    );
    const expectedVersion = spawnSync("/usr/bin/bash", [resolve(workspaceRoot, "verification/scripts/local-build-version.bash")], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: process.env
    });

    // When
    const result = spawnSync("just", ["build-local-workspace-image"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: bashEnvironment,
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

  it("packs and loads a temporary-tag image before promoting readiness", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runScript(fixture, "prepare-source-build.bash");
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(0);
    expect(await readFile(fixture.readiness, "utf8")).toBe("state=fresh\n");
    expect(invocations).toContain(`pack ${resolve(fixture.root, ".local/dim-packages")}`);
    expect(invocations).toMatch(/docker buildx build .* --load .* --tag dev-infra-project-workspace:prepare-1234-/);
    expect(invocations.indexOf("pack ")).toBeLessThan(invocations.indexOf("docker buildx build"));
    expect(invocations.indexOf("docker buildx build")).toBeLessThan(
      invocations.indexOf("state dev-infra-project-workspace:prepare-1234-")
    );
    expect(invocations.indexOf("state dev-infra-project-workspace:prepare-1234-")).toBeLessThan(
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
    const sources = resolve(root, ".local/production-source");
    await Promise.all([mkdir(scripts), mkdir(tools), mkdir(packages, { recursive: true })]);
    await copyFile(
      resolve(projectRoot, "scripts/local-preparation-state.bash"),
      resolve(scripts, "local-preparation-state.bash")
    );
    await writeFile(resolve(packages, "packages.json"), "{}\n");
    await writeFile(resolve(packages, "package.tgz"), "package bytes\n");
    for (const repository of ["core", "plugin-dns-cloudflare", "plugin-external-urls"]) {
      await mkdir(resolve(sources, repository), { recursive: true });
    }
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
  });

  it("leaves no readiness marker or promoted tag when preparation fails", async () => {
    // Given
    const fixture = await createFixture();
    await mkdir(resolve(fixture.root, ".local"), { recursive: true });
    await writeFile(fixture.readiness, "state=old\n");

    // When
    const result = runScript(fixture, "prepare-source-build.bash", { DIM_BUILD_FAILURE: "1" });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(42);
    await expect(readFile(fixture.readiness, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(invocations).not.toContain("docker image tag");
    expect(invocations).not.toContain("state dev-infra-project-workspace");
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
    expect(invocations).not.toContain("dim install-cli");
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
    expect(invocations).not.toContain("dim install-cli");
    expect(invocations).not.toContain("dim controller restart");
    expect(invocations).not.toContain("pack ");
    expect(invocations).not.toContain("docker build");
  });

  it("installs a prepared bundle without restarting the controller", async () => {
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
    expect(invocations).toContain("dim install-cli");
    expect(invocations).toContain("dim --version");
    expect(invocations).not.toContain("dim controller restart");
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
    expect(invocations).toContain("dim install-cli");
    expect(invocations).not.toContain("dim controller restart");
    expect(invocations).not.toMatch(/^pack /m);
    expect(invocations).not.toContain("docker build");
  });
});
