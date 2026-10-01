import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const workspaceUserSetup = "scripts/workspace-user-setup.bash";
const openCodeWebLauncher = "scripts/opencode-web.bash";
const openCodeWebLauncherFailureSmoke = "verification/scripts/opencode-web-launcher-failure-smoke.bash";
const openCodeWebRealRuntimeSmoke = "verification/scripts/opencode-web-real-runtime-smoke.bash";
const openCodeWebRealRuntimeFixture = "verification/scripts/opencode-web-real-runtime-fixture.mjs";
const projectToolTasksSmoke = "verification/scripts/project-tool-tasks-smoke.bash";
const remoteBootstrapBegin = "# DIM_REMOTE_BOOTSTRAP_BEGIN";
const remoteBootstrapEnd = "# DIM_REMOTE_BOOTSTRAP_END";

const workspaceSetupAgentDockerfiles = [
  "agent/Dockerfile",
  "examples/projects/full-development-flow/repos/root/.dim/agent/Dockerfile",
  "examples/projects/multi-repository/repos/root/.dim/agent/Dockerfile",
  "examples/projects/single-repository/repos/app/.dim/agent/Dockerfile"
];

const agentDockerfiles = [
  ...workspaceSetupAgentDockerfiles,
  "core/images/project-workspace/Dockerfile"
];

const projectEntrypoints = [
  ".dim/entrypoint.sh",
  "examples/projects/full-development-flow/repos/root/.dim/entrypoint.sh",
  "examples/projects/multi-repository/repos/root/.dim/entrypoint.sh",
  "examples/projects/single-repository/repos/app/.dim/entrypoint.sh"
];

const remoteBootstrapReadmes = [
  ["README.md", "dim-dev"],
  ["examples/projects/full-development-flow/README.md", "full-dev"],
  ["examples/projects/multi-repository/README.md", "example-dev"],
  ["examples/projects/single-repository/README.md", "single-dev"]
];

const exampleBootstrapReadmes = remoteBootstrapReadmes.slice(1);

describe("workspace-user setup policy", () => {
  it("publishes the authoritative setup script and checksum", () => {
    const artifacts = [
      workspaceUserSetup,
      `${workspaceUserSetup}.sha256`,
      openCodeWebLauncher,
      `${openCodeWebLauncher}.sha256`,
      openCodeWebLauncherFailureSmoke,
      openCodeWebRealRuntimeSmoke,
      openCodeWebRealRuntimeFixture,
      projectToolTasksSmoke
    ];
    expect(artifacts.map((path) => existsSync(resolve(workspaceRoot, path)))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true
    ]);
  });

  it("marks the root remote bootstrap and requires its commit from the environment", async () => {
    // Given
    const readme = await readFile(resolve(workspaceRoot, "README.md"), "utf8");

    // When
    const beginMarkers = readme.match(/^# DIM_REMOTE_BOOTSTRAP_BEGIN$/gm) ?? [];
    const endMarkers = readme.match(/^# DIM_REMOTE_BOOTSTRAP_END$/gm) ?? [];
    const begin = readme.indexOf(remoteBootstrapBegin);
    const end = readme.indexOf(remoteBootstrapEnd);
    const bootstrap = begin >= 0 && end > begin ? readme.slice(begin + remoteBootstrapBegin.length, end).trim() : "";
    const setup = 'dim workspace run dim-dev bash -- -s <"$setup_dir/workspace-user-setup.bash"';
    const launch = [
      "dim workspace run dim-dev bash -- -c \\",
      "    'export OPENCODE_WEB_CORS_ORIGINS=\"$1\"; exec bash -s' \\",
      '    bash "${OPENCODE_WEB_CORS_ORIGINS:-[]}" <"$setup_dir/opencode-web.bash"'
    ].join("\n");
    const checksum = bootstrap.indexOf("sha256sum --check");
    const setupExecution = bootstrap.indexOf(setup, checksum);
    const launchExecution = bootstrap.indexOf(launch, setupExecution);

    // Then
    expect(beginMarkers).toHaveLength(1);
    expect(endMarkers).toHaveLength(1);
    expect(bootstrap.startsWith("(")).toBe(true);
    expect(bootstrap.endsWith(")")).toBe(true);
    expect(bootstrap).toMatch(/FULL_DEVELOPMENT_COMMIT="\$\{DIM_DEVELOPMENT_COMMIT:\?[^}]+\}"/);
    expect(bootstrap).not.toContain("<FULL_DEVELOPMENT_COMMIT>");
    expect(checksum).toBeGreaterThan(-1);
    expect(setupExecution).toBeGreaterThan(checksum);
    expect(launchExecution).toBeGreaterThan(setupExecution);
    expect(readme.slice(end + remoteBootstrapEnd.length)).not.toContain(launch);
    expect(readme).toContain(
      "dim workspace run dim-dev tool-setup \\\n  && dim workspace run dim-dev agent"
    );
  });

  it("chains canonical Project setup and launch fail-closed", async () => {
    // Given
    const readme = await readFile(resolve(workspaceRoot, "README.md"), "utf8");

    // When
    const setup = "dim workspace run dim-dev tool-setup";
    const launch = "dim workspace run dim-dev agent";

    // Then
    expect(readme).toContain(`${setup} \\\n  && ${launch}`);
  });

  it("documents the literal OMO team-mode configuration key", async () => {
    // Given
    const paths = [
      "specification/docs/monorepo.md",
      "specification/docs/project-workspaces.md",
      "specification/docs/usage.md",
      "specification/specs/12-verification.md",
      "specification/specs/13-repo-workspace-lifecycle.md"
    ];

    // When
    const documents = await Promise.all(paths.map(async (path) => readFile(resolve(workspaceRoot, path), "utf8")));

    // Then
    for (const document of documents) {
      expect(document).toContain('`["[opencode]"].team_mode`');
      expect(document).not.toMatch(/`opencode\.team_mode`|`opencode`\s+object|opencode object/i);
    }
  });

  it("passes only exact pinned package coordinates to npm", async () => {
    const source = await readFile(resolve(workspaceRoot, workspaceUserSetup), "utf8");
    const installCommand = source.match(/npm install --global --prefix "\$install_prefix"[\s\S]*?"jsonc-parser@3\.3\.1"/);

    expect(installCommand).not.toBeNull();
    const command = installCommand?.[0] ?? "";
    for (const [constant, packageName, version] of [
      ["OPENCODE_VERSION", "opencode-ai", "1.18.31"],
      ["OMO_VERSION", "oh-my-openagent", "4.19.4"],
      ["JSONC_PARSER_VERSION", "jsonc-parser", "3.3.1"]
    ]) {
      expect(source).toContain(`readonly ${constant}="${version}"`);
      expect(command.match(new RegExp(`"${packageName.replaceAll("-", "\\-")}@${version.replaceAll(".", "\\.")}"`, "g"))).toHaveLength(1);
    }
    expect(command).not.toMatch(/@(latest|next|canary|\^|~|\*|>=)|(?:git|https?):/);
    expect(source).toContain('path.join(home, ".local")');
    expect(source).toContain("NPM_CONFIG_CACHE");
    expect(source).toContain("NPM_CONFIG_USERCONFIG");
  });

  it("updates active OMO configuration with bounded non-visual team mode", async () => {
    const source = await readFile(resolve(workspaceRoot, workspaceUserSetup), "utf8");

    expect(source).toContain('path.join(home, ".omo")');
    expect(source).toContain("omo.jsonc");
    expect(source).toContain('["[opencode]", "auto_update"]');
    expect(source).toContain('["[opencode]", "team_mode", key]');
    expect(source).toMatch(/\benabled\s*:\s*true\b/);
    expect(source).toMatch(/\bmax_parallel_members\s*:\s*4\b/);
    expect(source).toMatch(/\bmax_members\s*:\s*8\b/);
    expect(source).toMatch(/\btmux_visualization\s*:\s*false\b/);
  });

  it("confines configuration and npm state to a non-symlinked HOME", async () => {
    const source = await readFile(resolve(workspaceRoot, workspaceUserSetup), "utf8");

    expect(source).toMatch(/(?:realpath|realpathSync)/);
    expect(source).toMatch(/(?:lstat|lstatSync|readlink)/);
    expect(source).toMatch(/(?:flock|proper-lockfile|\.lock\b)/);
    expect(source).toContain("XDG_CONFIG_HOME");
    expect(source).toContain("XDG_CACHE_HOME");
    expect(source).toContain("XDG_DATA_HOME");
    expect(source).toContain("XDG_STATE_HOME");
    expect(source).toMatch(/\(\(\s*\$\{#setup_paths\[@\]\}\s*==\s*11\s*\)\)/);
  });

  it("uses targeted JSONC edits instead of whole-document serialization", async () => {
    const source = await readFile(resolve(workspaceRoot, workspaceUserSetup), "utf8");

    expect(source).toContain("modify");
    expect(source).toContain("applyEdits");
    expect(source).not.toMatch(/JSON\.stringify\(plan\.value/);
  });

  it("keeps setup non-interactive, immutable, and outside DIM authority", async () => {
    const source = await readFile(resolve(workspaceRoot, workspaceUserSetup), "utf8");

    expect(source).not.toMatch(/\bopencode\s+web\b/);
    expect(source).not.toMatch(/\bauth\s+login\b/);
    expect(source).not.toMatch(/\bgit\s+config\s+--global\b/);
    expect(source).not.toMatch(/@latest\b|\/latest(?:\/|\b)/);
    expect(source).not.toMatch(/(?:curl|wget)[^\n]*(?:opencode\.ai\/install|\/(?:main|master|HEAD)\/)/);
    expect(source).not.toMatch(/\bgit\s+clone[^\n]*(?:--branch|-b)\s+\S+/);
    expect(source).not.toMatch(/\bdim\s+(?:install-plugin|controller)\b/);
    expect(source).not.toMatch(/\bDIM_(?:CONTROLLER|PLUGIN)(?:_[A-Z0-9_]+)?\b/);
    expect(source).not.toMatch(/\bDIM_[A-Z0-9_]*(?:TOKEN|GRANT)\b/);
  });

  it.each(projectEntrypoints)("exposes the generic Project-owned tool task contract in %s", async (path) => {
    // Given
    const entrypoint = await readFile(resolve(workspaceRoot, path), "utf8");

    // When
    const setupTask = entrypoint.match(/^\s*tool-setup\)/m);
    const agentTask = entrypoint.match(/^\s*agent\)/m);

    // Then
    expect(setupTask).not.toBeNull();
    expect(agentTask).not.toBeNull();
    expect(entrypoint).toContain("DIM_PROJECT_TOOL_CONTRACT_VERSION=1");
    expect(entrypoint).toContain("DIM_PROJECT_TOOL_LAUNCHER=agent");
  });

  it("publishes and verifies the compatible installed launcher manifest", async () => {
    // Given
    const setup = await readFile(resolve(workspaceRoot, workspaceUserSetup), "utf8");
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");

    // When
    const manifestContract = setup.includes("contractVersion: 1");

    // Then
    expect(manifestContract).toBe(true);
    expect(setup).toContain("agent:");
    expect(setup).toContain("dim-project-tool-launch");
    expect(recipes).toContain("bash verification/scripts/project-tool-tasks-smoke.bash");
  });

  it("keeps generic tool task names outside core workspace behavior", async () => {
    // Given
    const corePaths = [
      "core/packages/cli/src/workspace-execution-commands.ts",
      "core/packages/cli/src/workspace-commands.ts",
      "core/packages/core/src/workspaceProjectCommands.ts",
      "core/packages/core/src/workspaceSetup.ts"
    ];

    // When
    const coreSources = await Promise.all(corePaths.map(async (path) => readFile(resolve(workspaceRoot, path), "utf8")));

    // Then
    for (const source of coreSources) {
      expect(source).not.toContain("tool-setup");
      expect(source).not.toContain("DIM_PROJECT_TOOL_");
      expect(source).not.toContain("dim-project-tool-launch");
    }
  });

  it("keeps authenticated Web launch separate and scoped", async () => {
    const source = await readFile(resolve(workspaceRoot, openCodeWebLauncher), "utf8");

    expect(source).toContain('EXPECTED_OPENCODE_VERSION="1.18.31"');
    expect(source).toContain("OPENCODE_SERVER_PASSWORD");
    expect(source).toContain("/global/health");
    expect(source).toContain("DIM_DEVELOPMENT_URL_SOCKET");
    expect(source).toContain("dim-development-service expose");
    expect(source).toContain("--name opencode-web");
    expect(source).toContain("--require-scheme https");
    expect(source).toContain("--hostname 127.0.0.1");
    expect(source).not.toContain("DIM_WEB_URL");
    expect(source).not.toContain("CONTAINERS_JSON");
    expect(source).not.toContain("DIM_EXTERNAL_URL_SOCKET");
    expect(source).not.toContain("DIM_EXTERNAL_URL_CONTAINERS_JSON");
    expect(source).toContain("process_owns_listener");
    expect(source).not.toMatch(/(?:curl|wget)[^\n]*(?:opencode\.ai\/install|@latest)/);
    expect(source).not.toMatch(/\bpkill\b|\bkillall\b|ps\s+[^\n]*opencode/);
    expect(source).not.toMatch(/auth_token=/);
  });

  it("runs the pinned OpenCode runtime verification lane", async () => {
    const source = await readFile(resolve(workspaceRoot, openCodeWebRealRuntimeSmoke), "utf8");
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");

    expect(source).toContain("1.18.31");
    expect(source).toContain("env -i");
    expect(source).toContain("dim-development-service");
    expect(source).toContain("generic-http");
    expect(source).toContain("31887");
    expect(source).not.toContain("DIM_WEB_URL");
    expect(source).toContain("opencode-web-real-runtime-smoke-ok");
    expect(recipes).toContain("bash verification/scripts/opencode-web-real-runtime-smoke.bash");
    expect(recipes).toContain("bash verification/scripts/opencode-web-launcher-failure-smoke.bash");
  });

  it.each(remoteBootstrapReadmes)("documents host-verified streaming setup in %s", async (path, workspace) => {
    // Given
    const readme = await readFile(resolve(workspaceRoot, path), "utf8");

    // When
    const temporaryDirectory = readme.indexOf('setup_dir="$(mktemp -d)"');
    const cleanupTrap = readme.indexOf("trap 'rm -rf -- \"$setup_dir\"' EXIT", temporaryDirectory);
    const checksumVerification = readme.indexOf("sha256sum --check", cleanupTrap);
    const setupTask = path === "README.md" ? "bash -- -s" : "tool-setup";
    const verifiedExecution = readme.indexOf(
      `dim workspace run ${workspace} ${setupTask} <"$setup_dir/workspace-user-setup.bash"`,
      checksumVerification
    );

    // Then
    expect(readme).toContain("set -euo pipefail");
    expect(readme).toMatch(/\[\[ "\$FULL_DEVELOPMENT_COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| \{/);
    expect(readme).toMatch(/setup_dir="\$\(mktemp -d\)"\n\s+trap 'rm -rf -- "\$setup_dir"' EXIT/);
    expect(readme.match(/"\$base\/(?:workspace-user-setup|opencode-web)\.bash(?:\.sha256)?"/g)).toHaveLength(4);
    expect(readme).not.toMatch(/(?:curl|wget)[^\n]*\|\s*(?:ba)?sh\b/);
    expect(temporaryDirectory).toBeGreaterThan(-1);
    expect(cleanupTrap).toBeGreaterThan(temporaryDirectory);
    expect(checksumVerification).toBeGreaterThan(cleanupTrap);
    expect(verifiedExecution).toBeGreaterThan(checksumVerification);
  });

  it.each(exampleBootstrapReadmes)("uses an operator-supplied provider-neutral raw source in %s", async (path) => {
    // Given
    const readme = await readFile(resolve(workspaceRoot, path), "utf8");

    // When
    const rawSourceInput = readme.indexOf(': "${DIM_DEVELOPMENT_RAW_ROOT:?');
    const normalizedRoot = readme.indexOf('development_raw_root="${DIM_DEVELOPMENT_RAW_ROOT%/}"', rawSourceInput);
    const immutableBase = readme.indexOf(
      'base="${development_raw_root}/${FULL_DEVELOPMENT_COMMIT}/scripts"',
      normalizedRoot
    );

    // Then
    expect(rawSourceInput).toBeGreaterThan(-1);
    expect(normalizedRoot).toBeGreaterThan(rawSourceInput);
    expect(immutableBase).toBeGreaterThan(normalizedRoot);
    expect(readme).not.toContain("raw.githubusercontent.com");
  });

  it("specifies remote-bootstrap confinement, locking, retry, and provider neutrality", async () => {
    // Given
    const specificationPaths = [
      "specification/docs/project-workspaces.md",
      "specification/specs/12-verification.md",
      "specification/specs/13-repo-workspace-lifecycle.md"
    ];

    // When
    const specifications = await Promise.all(
      specificationPaths.map(async (path) => readFile(resolve(workspaceRoot, path), "utf8"))
    );
    const combined = specifications.join("\n");

    // Then
    expect(combined).toMatch(/npm (?:prefix|install prefix).*cache.*user configuration.*descendants? of.*HOME/is);
    expect(combined).toMatch(/flock.*exclusive lock/is);
    expect(combined).toMatch(/failed\s+checksum.*MUST NOT.*(?:execute|invoke).*retry/is);
    expect(combined).toMatch(/example.*MUST.*provider-neutral.*raw-source root/is);
  });

  it.each(agentDockerfiles)("does not install Codex or Claude in %s", async (path) => {
    const dockerfile = await readFile(resolve(workspaceRoot, path), "utf8");

    expect(dockerfile).not.toMatch(/@openai\/codex|@anthropic-ai\/claude-code/);
  });

  it.each(workspaceSetupAgentDockerfiles)("provides flock in %s", async (path) => {
    const dockerfile = await readFile(resolve(workspaceRoot, path), "utf8");

    expect(dockerfile).toMatch(/apt-get install[^\n]*[\s\S]*?\butil-linux\b/);
  });

  it.each(projectEntrypoints)("does not expose Codex or Claude tasks in %s", async (path) => {
    const entrypoint = await readFile(resolve(workspaceRoot, path), "utf8");

    expect(entrypoint).not.toMatch(
      /^\s*(?:codex|claude)\)|--dangerously-(?:bypass-approvals-and-sandbox|skip-permissions)\b/m
    );
  });
});