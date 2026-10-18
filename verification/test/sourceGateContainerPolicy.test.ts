import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const wrapperPath = resolve(workspaceRoot, "verification/scripts/source-gate-container.bash");
const runnerPath = resolve(workspaceRoot, "verification/source-gate/run.bash");

describe("isolated source gate policy", () => {
  it("routes the default gate through the container while retaining the native gate", async () => {
    const recipes = await readFile(resolve(workspaceRoot, "justfile"), "utf8");
    const verificationRecipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");
    const liveTest = await readFile(
      resolve(workspaceRoot, "verification/live/nativeOrdinaryExecutorLive.test.ts"),
      "utf8"
    );
    const workspacePackage = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));

    expect(recipes).toMatch(/^check-source:\n    bash verification\/scripts\/source-gate-container\.bash$/m);
    expect(recipes).toMatch(/^check-source-container:\n    bash verification\/scripts\/source-gate-container\.bash$/m);
    expect(recipes).toMatch(/^check-source-native:[\s\S]*?^    just test$[\s\S]*?^    just build-packages$/m);
    expect(recipes).not.toContain("--exclude");
    expect(recipes).not.toContain("test-isolated");
    expect(workspacePackage.scripts["workspace:test"]).toBe("pnpm --workspace-concurrency=1 --recursive run test");
    expect(await readFile(resolve(workspaceRoot, "verification/vitest.config.ts"), "utf8"))
      .toContain('exclude: ["live/**"]');
    expect(verificationRecipes).toMatch(/^native-ordinary-executor-live:\n[\s\S]*?live\/nativeOrdinaryExecutorLive\.test\.ts$/m);
    expect(verificationRecipes).toContain("sysbox-runc");
    expect(verificationRecipes).toContain("DIM_TEST_NATIVE_RUNNER_IMAGE");
    expect(verificationRecipes).toContain("DIM_TEST_NATIVE_JOB_IMAGE");
    expect(liveTest).not.toContain(".skip");
  });

  it("copies the worktree without generated state, credentials, or a writable host mount", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");
    const archive = await readFile(resolve(workspaceRoot, "verification/source-gate/archive.bash"), "utf8");

    for (const excluded of [
      ".git", "node_modules", "dist", "userstate", ".local", ".gitcredentials", ".git-credentials",
      ".docker", ".netrc", ".ssh", ".env", ".npmrc"
    ]) {
      expect(archive).toContain(`--exclude='${excluded}'`);
    }
    expect(wrapper).toContain("source-gate/archive.bash");
    expect(wrapper).toContain("docker run --detach");
    expect(wrapper).toContain("--init");
    expect(wrapper).toContain("--security-opt no-new-privileges");
    expect(wrapper).not.toContain("docker network disconnect");
    expect(wrapper).toContain("git -C /workspace commit --quiet --message source-gate-snapshot");
    expect(wrapper).toContain('docker exec "$container" chmod --recursive a+rX /workspace');
    expect(wrapper).not.toMatch(/--volume|--mount|docker\.sock|\.gitcredentials.*(?:COPY|cp)/);
  });

  it("removes only its exactly owned container and propagates cleanup failure", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");

    expect(wrapper).toContain('--label "org.dim.verification=$verification_id"');
    expect(wrapper).toContain('--label "org.dim.resource=source-gate"');
    expect(wrapper).toContain("remove_owned_container");
    expect(wrapper).toContain("preserving source-gate container with foreign or malformed ownership");
    expect(wrapper).toContain('(( status != 0 )) || status=1');
    expect(wrapper).not.toMatch(/container rm[^\n]+\|\| true/);
  });

  it("runs the exact image ID emitted by its private build", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");

    expect(wrapper).toContain("--iidfile");
    expect(wrapper).toContain('[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(wrapper).toContain('"$image_id" >/dev/null');
    expect(wrapper).not.toContain("docker build --tag");
  });

  it("pins the isolated toolchain and installs dependencies before the native gate", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "verification/source-gate/Dockerfile"), "utf8");
    const runner = await readFile(runnerPath, "utf8");

    expect(dockerfile).toMatch(/^FROM python:3\.13\.7-slim-bookworm@sha256:[0-9a-f]{64} AS python$/m);
    expect(dockerfile).toMatch(/^FROM node:24\.19\.0-bookworm-slim@sha256:[0-9a-f]{64} AS source-toolchain$/m);
    expect(dockerfile).toMatch(/^FROM node:26\.5\.0-bookworm-slim@sha256:[0-9a-f]{64} AS node26-runtime$/m);
    expect(dockerfile).toContain("FROM source-toolchain AS source-node-26");
    expect(dockerfile).toContain("COPY --from=node26-runtime /usr/local/bin/node /usr/local/bin/node");
    expect(dockerfile).toContain('test "$(node --version)" = "v26.5.0"');
    expect(dockerfile).toContain("FROM source-toolchain AS source-node-24");
    expect(dockerfile).toContain("git-2.43.0.tar.xz");
    expect(dockerfile).toContain("5446603e73d911781d259e565750dcd277a42836c8e392cac91cf137aa9b76ec");
    expect(dockerfile).toContain("pnpm@10.13.1");
    expect(dockerfile).toContain("just-1.43.1");
    expect(dockerfile).toContain("docker.io");
    expect(dockerfile).toContain("openssh-client");
    expect(dockerfile).toContain("procps");
    expect(runner).toContain("export npm_config_workspace_concurrency=1");
    expect(runner).toContain('test "$(python3 --version)" = "Python 3.13.7"');
    expect(await readFile(wrapperPath, "utf8")).toContain("pnpm install --frozen-lockfile");
    expect(runner).toContain("exec just check-source-native");
    expect(runner).not.toContain("test-isolated");
    expect(runner).toContain('24) test "$(node --version)" = "v24.19.0"');
    expect(runner).toContain('26) test "$(node --version)" = "v26.5.0"');
  });

  it("runs hosted source and package checks in both disposable runtime lanes", async () => {
    const workflow = parse(await readFile(resolve(workspaceRoot, ".github/workflows/verify.yml"), "utf8"));
    const source = workflow.jobs.source;
    expect(workflow.on.push.branches).toContain("development");
    expect(source.strategy.matrix.node).toEqual([24, 26]);
    expect(source.strategy["fail-fast"]).toBe(false);
    const step = source.steps.find((step: { env?: Record<string, string> }) => step.env?.DIM_SOURCE_NODE_MAJOR);
    expect(step.env.DIM_SOURCE_NODE_MAJOR).toBe("${{ matrix.node }}");
    expect(step.run).toContain("bash verification/scripts/source-gate-container.bash");
    expect(step.run).toContain("just check-source-native && just verify package-packs && pnpm audit --prod");
    expect(source.steps.some((step: { run?: string }) => step.run === "just check-source-native")).toBe(false);
    const artifact = source.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(artifact.with.name).toContain("${{ matrix.node }}");
    expect(artifact.with.name).toContain("${{ github.sha }}");
  });

  it("selects both container runtimes in the local matrix instead of relabelling a Node 24 run", async () => {
    const matrix = await readFile(resolve(workspaceRoot, "verification/scripts/local-ci-matrix.bash"), "utf8");
    expect(matrix).toContain("for node_major in 24 26; do");
    expect(matrix).toContain('DIM_SOURCE_NODE_MAJOR="$node_major" bash verification/scripts/source-gate-container.bash');
    expect(matrix).toContain("just check-source-native && just verify package-packs && pnpm audit --prod");
    expect(matrix).not.toContain("just check-source &&");
  });

  it.each([wrapperPath, runnerPath])("has valid Bash syntax in %s", (script) => {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
  });
});
