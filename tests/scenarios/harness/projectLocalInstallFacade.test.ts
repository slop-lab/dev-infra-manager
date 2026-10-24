import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoots: string[] = [];
const packageVersion = `0.10.0-local-${"a".repeat(64)}`;
const imageRef = `dev-infra-project-workspace:${packageVersion}`;

type Fixture = {
  readonly root: string;
  readonly tools: string;
  readonly log: string;
  readonly oldFacadeMutation: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-project-local-install-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const packageRoot = resolve(root, ".local/dim-packages");
  const log = resolve(root, "invocations.log");
  const oldFacadeMutation = resolve(root, "old-facade-mutated");
  await Promise.all([scripts, tools, packageRoot, resolve(scripts, "local-uninstall")].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all(
    ["install-source-build.bash", "local-package-version.bash", "install-local-profile.ts", "local-uninstall/command.ts", "local-uninstall/files.ts"].map((script) =>
      copyFile(resolve(workspaceRoot, "scripts", script), resolve(scripts, script))
    )
  );
  for (const helper of ["install-local-existing-control-plane.ts", "install-local-control-plane.ts", "install-local-web.ts", "install-local-llm-operator.ts", "install-local-llm-gateway.ts", "install-local-shared-ingress.ts", "configure-local-web.ts"]) await writeFile(resolve(scripts, helper),
    'import { appendFileSync } from "node:fs"; appendFileSync(process.env.DIM_INVOCATIONS!, `web-helper ${process.argv[1]} ${process.argv.slice(2).join(" ")}\\n`); if(process.env.DIM_EXISTING_PREFLIGHT_FAILURE && process.argv.includes("--check")) process.exit(39);\n');
  const loaderDirectory = resolve(root, "tests/node_modules/tsx/dist");
  await mkdir(loaderDirectory, { recursive: true });
  await writeFile(resolve(loaderDirectory, "loader.mjs"), "// Disposable orchestration fixture; production helper is tested separately.\n");
  await writeFile(resolve(root, ".local/prepared-local.state"), "state=fresh\n");
  await writeFile(
    resolve(packageRoot, "packages.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: [
      { name: "@slop-lab/dim-cli", version: packageVersion, file: "slop-lab-dim-cli-local.tgz" },
      { name: "@slop-lab/dim-installer", version: packageVersion, file: "slop-lab-dim-installer-local.tgz" },
      ...["dns-cloudflare", "external-urls", "mirrors"].map((name) => ({ name: `@slop-lab/dim-host-plugin-${name}`, version: packageVersion, file: `slop-lab-dim-host-plugin-${name}-local.tgz` })),
      { name: "@slop-lab/dim-control-plane-plugin-git-repositories", version: packageVersion, file: "slop-lab-dim-control-plane-plugin-git-repositories-local.tgz" }
    ] })}\n`
  );
  await writeFile(resolve(packageRoot, "slop-lab-dim-cli-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-installer-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-host-plugin-dns-cloudflare-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-host-plugin-external-urls-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-host-plugin-mirrors-local.tgz"), "");
  await writeFile(resolve(packageRoot, "unrelated-plugin-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-control-plane-plugin-git-repositories-local.tgz"), "");
  await writeFile(resolve(scripts, "local-preparation-state.bash"), `#!/usr/bin/bash
expected_ref=${JSON.stringify(imageRef)}
[[ "$DIM_LOCAL_IMAGE_INSPECT_REF" == "$expected_ref" ]]
[[ "$DIM_LOCAL_IMAGE_RECORD_REF" == "$expected_ref" ]]
printf 'state %s %s\n' "$DIM_LOCAL_IMAGE_INSPECT_REF" "$DIM_LOCAL_IMAGE_RECORD_REF" >>"$DIM_INVOCATIONS"
printf 'state=fresh\n'
`);
  await writeFile(resolve(tools, "flock"), "#!/usr/bin/bash\nexit 0\n");
  await writeFile(resolve(tools, "node"), `#!/usr/bin/bash
exec ${JSON.stringify(process.execPath)} "$@"
`);
  await writeFile(resolve(tools, "dim"), `#!/usr/bin/bash
touch "$DIM_OLD_FACADE_MUTATION"
{ printf 'old-dim'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "$1 $2 $3" == "installer install core" ]]; then
  for variable in DIM_RUNTIME_MARKER DIM_CONFIG_MARKER DIM_FACADE_MARKER DIM_PLUGINS_MARKER DIM_IMAGE_MARKER; do
    if [[ -n "\${!variable:-}" ]]; then printf 'mutated\n' >"\${!variable}"; fi
  done
fi
`);
  await writeFile(resolve(tools, "npm"), `#!/usr/bin/bash
set -euo pipefail
{ printf 'npm'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
prefix=""
for ((index=1; index <= $#; index++)); do
  if [[ "\${!index}" == "--prefix" ]]; then
    next=$((index + 1))
    prefix="\${!next}"
  fi
done
[[ -n "$prefix" ]]
mkdir -p "$prefix/node_modules/.bin"
cat >"$prefix/node_modules/.bin/dim" <<'SCRIPT'
#!/usr/bin/bash
{ printf 'target-dim'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "\${DIM_PREFLIGHT_FAILURE:-0}" == 1 && "$1 $2 $3" == "installer install core" ]]; then exit 47; fi
SCRIPT
chmod +x "$prefix/node_modules/.bin/dim"
`);
  await Promise.all([
    resolve(scripts, "local-preparation-state.bash"),
    resolve(tools, "flock"),
    resolve(tools, "node"),
    resolve(tools, "dim"),
    resolve(tools, "npm")
  ].map((path) => chmod(path, 0o755)));
  return { root, tools, log, oldFacadeMutation };
}

function runInstaller(fixture: Fixture, environment: Readonly<Record<string, string>> = {}, arguments_: readonly string[] = []) {
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts/install-source-build.bash"), ...arguments_], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      HOME: resolve(fixture.root, "home"),
      DIM_DATA_HOME: resolve(fixture.root, "installed/data"),
      DIM_CONFIG_PATH: resolve(fixture.root, "installed/config"),
      DIM_STATE_ROOT: resolve(fixture.root, "installed/state"),
      DIM_INVOCATIONS: fixture.log,
      DIM_OLD_FACADE_MUTATION: fixture.oldFacadeMutation,
      ...environment
    }
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Project local install facade", () => {
  it("installs the complete prepared development profile and restarts the controller", async () => {
    const fixture = await createFixture();
    const result = runInstaller(fixture);
    const invocations = await readFile(fixture.log, "utf8");
    expect(result.status, result.stderr).toBe(0);
    expect(invocations).toMatch(/^target-dim installer install core --local-packages .* --no-local-bin --with-managed$/m);
    expect(invocations).toContain("/scripts/install-local-control-plane.ts ");
    expect(invocations).toContain("/scripts/install-local-web.ts ");
    expect(invocations.indexOf("installer install control-plane plugin ")).toBeLessThan(invocations.indexOf("/scripts/install-local-control-plane.ts "));
    expect(invocations.indexOf("/scripts/install-local-control-plane.ts ")).toBeLessThan(invocations.indexOf("/scripts/install-local-web.ts "));
    expect(invocations).toContain("/scripts/install-local-llm-operator.ts ");
    expect(invocations).toContain("/scripts/install-local-shared-ingress.ts ");
    expect(invocations.indexOf("/scripts/install-local-llm-operator.ts ")).toBeLessThan(invocations.indexOf("/scripts/configure-local-web.ts "));
    expect(invocations).toContain(`installer install plugin --local-packages ${fixture.root}/.local/dim-packages @slop-lab/dim-host-plugin-dns-cloudflare@${packageVersion} @slop-lab/dim-host-plugin-external-urls@${packageVersion} @slop-lab/dim-host-plugin-mirrors@${packageVersion}`);
    expect(invocations).toContain(`installer install control-plane plugin --local-packages ${fixture.root}/.local/dim-packages @slop-lab/dim-control-plane-plugin-git-repositories@${packageVersion}`);
    expect(invocations).toContain("controller restart");
    expect(invocations).not.toContain("unrelated-plugin");
    expect(invocations).not.toContain("old-dim");
    expect(invocations.split("\n")[0]).toBe(`state ${imageRef} ${imageRef}`);
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts --with-managed as the same complete development profile", async () => {
    const fixture = await createFixture();
    const result = runInstaller(fixture, {}, ["--with-managed"]);
    const invocations = await readFile(fixture.log, "utf8");
    expect(result.status, result.stderr).toBe(0);
    expect(invocations).toMatch(/^target-dim installer install core --local-packages .* --no-local-bin --with-managed$/m);
    expect(invocations).toContain(`installer install plugin --local-packages ${fixture.root}/.local/dim-packages @slop-lab/dim-host-plugin-dns-cloudflare@${packageVersion} @slop-lab/dim-host-plugin-external-urls@${packageVersion} @slop-lab/dim-host-plugin-mirrors@${packageVersion}`);
    expect(invocations).toContain(`installer install control-plane plugin --local-packages ${fixture.root}/.local/dim-packages @slop-lab/dim-control-plane-plugin-git-repositories@${packageVersion}`);
    expect(invocations).toContain("controller restart");
    expect(invocations).not.toContain("unrelated-plugin");
  });

  it("installs a host with existing service connections and never invokes local deployment helpers", async () => {
    const fixture = await createFixture(), connections = resolve(fixture.root, "private-connections");
    const result = runInstaller(fixture, {}, ["--connections", connections, "--control-plane-ssh", "control-host"]);
    expect(result.status, result.stderr).toBe(0);
    const invocations = await readFile(fixture.log, "utf8");
    expect(invocations).toContain(`--check --connections ${connections} --control-plane-ssh control-host`);
    expect(invocations.indexOf("--check --connections")).toBeLessThan(invocations.indexOf("target-dim installer install core"));
    expect(invocations).toContain("installer install plugin");
    expect(invocations).toContain("install-local-web.ts");
    expect(invocations).toContain("controller restart");
    expect(invocations).not.toContain("installer install control-plane");
    for (const helper of ["install-local-control-plane.ts", "install-local-llm-operator.ts", "install-local-shared-ingress.ts"]) expect(invocations).not.toContain(helper);
  });

  it("refuses an empty existing-control-plane selection instead of falling back to local deployment", async () => {
    const fixture = await createFixture();
    for (const args of [["--connections", ""], ["--connections", resolve(fixture.root, "connections"), "--control-plane-ssh", ""]]) {
      const result = runInstaller(fixture, {}, args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("requires one");
    }
    await expect(readFile(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains existing-control-plane mode on later bare install and stops before mutation when preflight fails", async () => {
    const fixture = await createFixture(), configHome = resolve(fixture.root, "config");
    await mkdir(resolve(configHome, "dim/existing-control-plane"), { recursive: true });
    await writeFile(resolve(configHome, "dim/existing-control-plane/selection.json"), "{}");
    const refused = runInstaller(fixture, { XDG_CONFIG_HOME: configHome, DIM_EXISTING_PREFLIGHT_FAILURE: "1" });
    expect(refused.status).toBe(39);
    let calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain("--check --saved");
    expect(calls).not.toContain("npm");
    expect(calls).not.toContain("target-dim");
    const result = runInstaller(fixture, { XDG_CONFIG_HOME: configHome });
    expect(result.status, result.stderr).toBe(0);
    calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain("installer install plugin");
    expect(calls).not.toContain("installer install control-plane");
    expect(calls).not.toContain("install-local-control-plane.ts");
  });

  it("preserves prepared and installed bytes when target compatibility refuses", async () => {
    // Given
    const fixture = await createFixture();
    const temporaryRoot = resolve(fixture.root, "temporary");
    const protectedPaths = [
      resolve(fixture.root, ".local/prepared-local.state"),
      resolve(fixture.root, ".local/dim-packages/packages.json"),
      resolve(fixture.root, "installed/runtime"),
      resolve(fixture.root, "installed/config"),
      resolve(fixture.root, "installed/facade"),
      resolve(fixture.root, "installed/plugins"),
      resolve(fixture.root, "installed/image")
    ] as const;
    await Promise.all([temporaryRoot, resolve(fixture.root, "installed")]
      .map((directory) => mkdir(directory, { recursive: true })));
    await Promise.all(protectedPaths.slice(2).map((path) => writeFile(path, `preserved:${path}\n`)));
    const before = await Promise.all(protectedPaths.map((path) => readFile(path)));

    // When
    const result = runInstaller(fixture, {
      TMPDIR: temporaryRoot,
      DIM_PREFLIGHT_FAILURE: "1",
      DIM_RUNTIME_MARKER: protectedPaths[2],
      DIM_CONFIG_MARKER: protectedPaths[3],
      DIM_FACADE_MARKER: protectedPaths[4],
      DIM_PLUGINS_MARKER: protectedPaths[5],
      DIM_IMAGE_MARKER: protectedPaths[6]
    });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(47);
    expect(invocations).toMatch(/^target-dim installer install core /m);
    expect(invocations).not.toContain("old-dim");
    expect(invocations).not.toContain("installer install plugin");
    expect(invocations).not.toContain("/scripts/install-local-control-plane.ts");
    expect(invocations).not.toContain("controller restart");
    expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before);
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
