import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];

type Fixture = {
  readonly root: string;
  readonly tools: string;
  readonly log: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-local-install-facade-"));
  fixtureRoots.push(root);
  const tools = resolve(root, "tools");
  const log = resolve(root, "invocations.log");
  await mkdir(tools);
  await writeFile(resolve(tools, "bash"), `#!/usr/bin/bash
set -euo pipefail
package_root="$2"
mkdir -p "$package_root"
touch "$package_root/slop-lab-dim-plugin-dns-cloudflare-local.tgz"
touch "$package_root/slop-lab-dim-plugin-external-urls-local.tgz"
touch "$package_root/slop-lab-dim-installer-local.tgz"
touch "$package_root/unrelated-plugin-local.tgz"
cat >"$package_root/packages.json" <<'JSON'
{"schemaVersion":1,"packages":[
  {"name":"@slop-lab/dim-plugin-dns-cloudflare","file":"slop-lab-dim-plugin-dns-cloudflare-local.tgz"},
  {"name":"@slop-lab/dim-plugin-external-urls","file":"slop-lab-dim-plugin-external-urls-local.tgz"},
  {"name":"@slop-lab/dim-installer","file":"slop-lab-dim-installer-local.tgz"},
  {"name":"@example/unrelated-plugin","file":"unrelated-plugin-local.tgz"}
]}
JSON
`);
  await writeFile(resolve(tools, "mise"), `#!/usr/bin/bash
{ printf 'mise'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "\${DIM_PLUGIN_FAILURE:-0}" == 1 && "$*" == *" enable-plugin "* ]]; then exit 41; fi
`);
  await Promise.all(["bash", "mise"].map((tool) => chmod(resolve(tools, tool), 0o755)));
  return { root, tools, log };
}

async function removeMise(fixture: Fixture): Promise<void> {
  await rm(resolve(fixture.tools, "mise"));
  await writeFile(resolve(fixture.tools, "npm"), `#!/usr/bin/bash
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
if [[ "$*" == *" --global "* ]]; then bin="$prefix/bin"; else bin="$prefix/node_modules/.bin"; fi
mkdir -p "$bin"
cat >"$bin/dim" <<'SCRIPT'
#!/usr/bin/bash
{ printf 'dim'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "\${DIM_PREFLIGHT_FAILURE:-0}" == 1 && "$1" == "install-cli" ]]; then exit 47; fi
SCRIPT
chmod +x "$bin/dim"
`);
  await chmod(resolve(fixture.tools, "npm"), 0o755);
}

function runInstaller(fixture: Fixture, environment: Readonly<Record<string, string>> = {}) {
  return spawnSync("/usr/bin/bash", [resolve(workspaceRoot, "verification/scripts/install-dim-local.bash")], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      HOME: resolve(fixture.root, "home"),
      DIM_INVOCATIONS: fixture.log,
      ...environment
    }
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local install facade", () => {
  it("installs the CLI before enabling only the intended local plugins", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runInstaller(fixture);
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(invocations).toMatch(/^mise exec -- dim install-cli --local-packages .* --no-local-bin$/m);
    expect(invocations).toContain("mise exec -- dim enable-plugin @slop-lab/dim-plugin-dns-cloudflare @slop-lab/dim-plugin-external-urls");
    expect(invocations).not.toContain("unrelated-plugin-local.tgz");
    expect(invocations.indexOf(" install-cli ")).toBeLessThan(invocations.indexOf(" enable-plugin "));
  });

  it("propagates plugin activation failure", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runInstaller(fixture, { DIM_PLUGIN_FAILURE: "1" });

    // Then
    expect(result.status).toBe(41);
  });

  it("does not promote a non-mise facade when target compatibility rejects installation", async () => {
    // Given
    const fixture = await createFixture();
    await removeMise(fixture);
    const installPrefix = resolve(fixture.root, "install-prefix");

    // When
    const result = runInstaller(fixture, {
      DIM_INSTALL_PREFIX: installPrefix,
      DIM_PREFLIGHT_FAILURE: "1"
    });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status).toBe(47);
    expect(invocations).toMatch(/^npm install --prefix .*\/installer --no-save --no-fund --no-audit /m);
    expect(invocations).toMatch(/^dim install-cli --local-packages .* --no-local-bin$/m);
    expect(invocations).not.toContain("npm install --global");
    expect(invocations).not.toContain("enable-plugin");
    await expect(readFile(resolve(installPrefix, "bin", "dim"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes the non-mise facade only after target compatibility succeeds", async () => {
    // Given
    const fixture = await createFixture();
    await removeMise(fixture);
    const installPrefix = resolve(fixture.root, "install-prefix");

    // When
    const result = runInstaller(fixture, { DIM_INSTALL_PREFIX: installPrefix });
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(invocations.indexOf(" install-cli ")).toBeLessThan(invocations.indexOf("npm install --global"));
    expect(invocations.indexOf("npm install --global")).toBeLessThan(invocations.indexOf(" enable-plugin "));
  });
});
