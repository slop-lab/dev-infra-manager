import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];
const packageVersion = `0.9.0-local-${"a".repeat(64)}`;
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
  await Promise.all([scripts, tools, packageRoot].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all(
    ["install-source-build.bash", "local-package-version.bash"].map((script) =>
      copyFile(resolve(workspaceRoot, "scripts", script), resolve(scripts, script))
    )
  );
  await writeFile(resolve(root, ".local/prepared-local.state"), "state=fresh\n");
  await writeFile(
    resolve(packageRoot, "packages.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: [
      { name: "@slop-lab/dim-cli", version: packageVersion, file: "slop-lab-dim-cli-local.tgz" },
      { name: "@slop-lab/dim-installer", version: packageVersion, file: "slop-lab-dim-installer-local.tgz" }
    ] })}\n`
  );
  await writeFile(resolve(packageRoot, "slop-lab-dim-cli-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-installer-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-plugin-dns-cloudflare-local.tgz"), "");
  await writeFile(resolve(packageRoot, "slop-lab-dim-plugin-external-urls-local.tgz"), "");
  await writeFile(resolve(packageRoot, "unrelated-plugin-local.tgz"), "");
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
if [[ "\${DIM_PLUGIN_FAILURE:-0}" == 1 && "$1 $2" == "installer enable-plugin" ]]; then exit 42; fi
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

function runInstaller(fixture: Fixture, environment: Readonly<Record<string, string>> = {}) {
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts/install-source-build.bash")], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
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
  it("enables only the intended prepared plugins after installing the CLI", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runInstaller(fixture);
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(invocations).toMatch(/^npm install --prefix \/tmp\/dim-target-installer\.[^ ]+ --no-save --no-fund --no-audit /m);
    expect(invocations).toMatch(/^target-dim installer install core --local-packages .* --no-local-bin$/m);
    expect(invocations).toContain("target-dim installer enable-plugin @slop-lab/dim-plugin-dns-cloudflare @slop-lab/dim-plugin-external-urls");
    expect(invocations).not.toContain("old-dim");
    expect(invocations).not.toContain("unrelated-plugin-local.tgz");
    expect(invocations.indexOf(" installer install core ")).toBeLessThan(invocations.indexOf(" installer enable-plugin "));
    expect(invocations.match(/^state /gm)).toHaveLength(2);
    expect(invocations).toContain(`state ${imageRef} ${imageRef}`);
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates prepared plugin activation failure", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runInstaller(fixture, { DIM_PLUGIN_FAILURE: "1" });

    // Then
    expect(result.status).toBe(42);
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
    expect(invocations).not.toContain("installer enable-plugin");
    expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before);
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
