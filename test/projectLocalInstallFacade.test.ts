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
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-project-local-install-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const packageRoot = resolve(root, ".local/dim-packages");
  const log = resolve(root, "invocations.log");
  await Promise.all([scripts, tools, packageRoot].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all(
    ["install-source-build.bash", "local-package-version.bash"].map((script) =>
      copyFile(resolve(workspaceRoot, "project/scripts", script), resolve(scripts, script))
    )
  );
  await writeFile(resolve(root, ".local/prepared-local.state"), "state=fresh\n");
  await writeFile(
    resolve(packageRoot, "packages.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: [{ name: "@slop-lab/dim-cli", version: packageVersion, file: "slop-lab-dim-cli-local.tgz" }] })}\n`
  );
  await writeFile(resolve(packageRoot, "slop-lab-dim-cli-local.tgz"), "");
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
{ printf 'dim'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
if [[ "\${DIM_PLUGIN_FAILURE:-0}" == 1 && "$1" == "enable-plugin" ]]; then exit 42; fi
`);
  await Promise.all([
    resolve(scripts, "local-preparation-state.bash"),
    resolve(tools, "flock"),
    resolve(tools, "node"),
    resolve(tools, "dim")
  ].map((path) => chmod(path, 0o755)));
  return { root, tools, log };
}

function runInstaller(fixture: Fixture, environment: Readonly<Record<string, string>> = {}) {
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts/install-source-build.bash")], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_INVOCATIONS: fixture.log,
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
    expect(invocations).toMatch(/^dim install-cli --local-packages .* --no-local-bin$/m);
    expect(invocations).toContain("dim enable-plugin @slop-lab/dim-plugin-dns-cloudflare @slop-lab/dim-plugin-external-urls");
    expect(invocations).not.toContain("unrelated-plugin-local.tgz");
    expect(invocations.indexOf(" install-cli ")).toBeLessThan(invocations.indexOf(" enable-plugin "));
    expect(invocations.match(/^state /gm)).toHaveLength(2);
    expect(invocations).toContain(`state ${imageRef} ${imageRef}`);
  });

  it("propagates prepared plugin activation failure", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runInstaller(fixture, { DIM_PLUGIN_FAILURE: "1" });

    // Then
    expect(result.status).toBe(42);
  });
});
