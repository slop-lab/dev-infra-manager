import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = process.env.DIM_TEST_ROOT_REPOSITORY ?? workspaceRoot;

describe("DIM development forge policy", () => {
  it("gives local install bundles a source-specific package version", async () => {
    const localPack = await readFile(
      resolve(workspaceRoot, "verification/scripts/pack-local-packages.bash"),
      "utf8"
    );
    const localVersion = await readFile(
      resolve(workspaceRoot, "verification/scripts/local-build-version.bash"),
      "utf8"
    );
    expect(localPack).toContain('bash "$script_dir/local-build-version.bash"');
    expect(localPack).toContain("DIM_LOCAL_BUILD_VERSION");
    expect(localVersion).toContain('git -C "$root_repository"');
    expect(localVersion).toContain("rev-parse HEAD");
    expect(localVersion).not.toContain("rev-parse --short");
    expect(localVersion).toContain("aggregate-lock-sha256");
    expect(localVersion).toContain("sha256sum");

    const sourcePack = await readFile(resolve(projectRoot, "scripts/pack-source-build.bash"), "utf8");
    expect(sourcePack).toContain("git -C");
    expect(sourcePack).toContain("rev-parse HEAD");
    expect(sourcePack).toContain("DIM_SOURCE_ROOT_COMMIT");
    expect(sourcePack).toContain("archive --format=tar");
    expect(sourcePack).toContain("sha256sum");
    expect(sourcePack).toContain("DIM_LOCAL_BUILD_VERSION");
    expect(sourcePack).toContain("-local-");
    expect(sourcePack).not.toContain("DIM_SOURCE_REPOSITORY_BASE_URL%/");
  });

  it("uses the exact reviewed Verdaccio dependency from the verification workspace", async () => {
    const packageManifest = parse(await readFile(resolve(workspaceRoot, "verification/package.json"), "utf8"));
    expect(packageManifest.devDependencies.verdaccio).toBe("6.8.0");

    const helper = await readFile(resolve(workspaceRoot, "verification/scripts/lib/local-npm-registry.bash"), "utf8");
    expect(helper).not.toContain("npx");
    expect(helper).not.toContain("--yes");
    expect(helper).toContain('verdaccio_bin="$script_dir/../../node_modules/verdaccio/bin/verdaccio"');
    expect(helper).toContain('exec setsid node "$verdaccio_bin"');
  });

  it("keeps persistent QEMU cache mutation in the protected root", async () => {
    const hook = resolve(workspaceRoot, ".dim/ci/qemu-cache.bash");
    expect(spawnSync("bash", ["-n", hook]).status).toBe(0);
    const source = await readFile(hook, "utf8");
    expect(source).toContain("noble-server-cloudimg-amd64.img");
    expect(source).toContain("6e40c07ae715f744f84af0bec76415cc1987dd115b4b8de437818561f01a3733");
    expect(source).toContain("sha256sum --check");
  });

  it("runs the full-development contract in the Sysbox QEMU lane", async () => {
    const gate = await readFile(resolve(workspaceRoot, "verification/scripts/kvm-host-install-smoke.bash"), "utf8");
    const kvm = await readFile(resolve(workspaceRoot, ".dim/qemu-verify.bash"), "utf8");
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");
    const workflow = await readFile(resolve(workspaceRoot, "verification/.gitea/workflows/repository-set.yml"), "utf8");
    expect(kvm).toContain('backend="sysbox"');
    expect(kvm).toContain("just verify full-development");
    expect(kvm).toContain('2>&1 | tee "$step_log"');
    expect(gate).toContain(".dim/qemu-service.mjs");
    expect(gate).toContain('node "$client" run');
    expect(kvm).toContain("pnpm run workspace:build");
    expect(kvm).toContain('guest_cpus="${DIM_KVM_SMOKE_CPUS:-4}"');
    expect(kvm).toContain('-smp "$guest_cpus"');
    expect(kvm).toContain('${DIM_KVM_PRESERVE_ON_FAILURE:-0}');
    expect(kvm).toContain("preserving failed guest");
    expect(kvm.indexOf("pnpm run workspace:build")).toBeLessThan(
      kvm.indexOf('run_step "install $backend backend"')
    );
    expect(recipes).toContain("DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox");
    expect(recipes).toContain("DIM_SELF_WORKSPACE_BACKEND=sysbox");
    expect(workflow.match(/with-ci-registry-cache\.bash --qemu-relay/g)).toHaveLength(2);
    const verificationSteps: readonly {
      readonly name?: string;
      readonly env?: Readonly<Record<string, unknown>>;
    }[] = parse(workflow).jobs.verify.steps;
    const sourceVerification = verificationSteps.filter(
      (step) => step.name === "Verify source repository set"
    );
    const containerVerification = verificationSteps.filter(
      (step) => step.name === "Verify container integration"
    );
    const fullDevelopmentVerification = verificationSteps.filter(
      (step) => step.name === "Verify full development integration"
    );
    expect(sourceVerification).toHaveLength(1);
    expect(containerVerification).toHaveLength(1);
    expect(fullDevelopmentVerification).toHaveLength(1);
    expect(
      verificationSteps.filter((step) => Object.hasOwn(step.env ?? {}, "DIM_TEST_PTY_RESIZE"))
    ).toHaveLength(1);
    expect(sourceVerification[0]?.env?.["DIM_TEST_PTY_RESIZE"]).toBe("unsupported");
    expect(Object.hasOwn(containerVerification[0]?.env ?? {}, "DIM_TEST_PTY_RESIZE")).toBe(false);
    expect(Object.hasOwn(fullDevelopmentVerification[0]?.env ?? {}, "DIM_TEST_PTY_RESIZE")).toBe(false);
    expect(workflow).toContain("just verify agent-control-kvm");
    expect(workflow).not.toContain("dim-ci-runner-health");
    expect(workflow).not.toContain("actions/setup-node");
    expect(workflow).not.toContain("Bootstrap Node.js");
  });

  it("owns CI job images and required tools in the protected Project contract", async () => {
    const contract = parse(await readFile(resolve(workspaceRoot, ".dim/ci/runner.yml"), "utf8"));
    const expectedImage =
      "nixery.dev/shell/bash/coreutils/gnused/gawk/jq/findutils/gnugrep/perl/util-linux/diffutils/tini/gnutar/gzip/curl/git/nodejs/python3/docker-client/just/socat@sha256:ff3c058b36be01e839a7f419fd5b18a574b9a8084fc883ea88ccb9e7dc353b6a";
    expect(contract.schemaVersion).toBe(1);
    expect(Object.keys(contract.workloads).sort()).toEqual(["integration", "ordinary"]);
    expect(contract.workloads.ordinary.labels).toEqual(["dim"]);
    expect(contract.workloads.integration.labels).toEqual(["dim-container-integration"]);
    expect(contract.workloads.integration.capabilities).toEqual(["nested-docker"]);
    for (const workload of Object.values(contract.workloads) as Array<Record<string, unknown>>) {
      expect(workload.image).toBe(expectedImage);
      expect(workload.image).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(String(workload.image).split("@")[0]).not.toMatch(/:[^/]+$/);
      expect(workload.tools).toEqual(expect.arrayContaining([
        "awk", "bash", "find", "flock", "git", "grep", "jq", "node", "perl", "python3", "readlink", "sed", "tini"
      ]));
    }
  });

  it("gives the managed CI runner example its own protected runner contract", async () => {
    const contract = parse(await readFile(
      resolve(workspaceRoot, "examples/features/ci-runner/repos/root/.dim/ci/runner.yml"),
      "utf8",
    ));

    expect(contract.schemaVersion).toBe(1);
    expect(contract.workloads.ordinary.labels).toEqual(["dim"]);
    expect(contract.workloads.integration.capabilities).toEqual(["nested-docker"]);
    expect(contract.workloads.ordinary.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("runs all managed workflow labels in disposable job containers", async () => {
    const workflowPaths = [
      ".gitea/workflows/verify.yml",
      ".gitea/workflows/release-gate.yml",
      "verification/.gitea/workflows/integration.yml",
      "verification/.gitea/workflows/repository-set.yml"
    ];
    for (const path of workflowPaths) {
      const workflow = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(workflow).not.toContain(":host");
      expect(workflow).not.toContain("dim-ci-runner-health");
    }
  });

  it("builds rootless agent DinD without inherited file-capability layers", async () => {
    for (const path of [
      "examples/projects/full-development-flow/repos/root/.dim/agent-dind/Dockerfile",
      "examples/projects/single-repository/repos/app/.dim/dind/Dockerfile",
      "examples/projects/multi-repository/repos/root/.dim/agent-dind/Dockerfile"
    ]) {
      const dockerfile = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(dockerfile).toContain("FROM docker:29.1.3-dind-rootless");
    }
  });

  it("mounts each example agent workspace from Project-owned persistent data", async () => {
    for (const path of [
      "examples/projects/full-development-flow/repos/root/.dim/docker-compose.yml",
      "examples/projects/single-repository/repos/app/.dim/docker-compose.yml",
      "examples/projects/multi-repository/repos/root/.dim/docker-compose.yml"
    ]) {
      const compose = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(compose).toContain("${DIM_WORKSPACE_DATA:?}/project:/workspace");
      expect(compose).not.toContain("..:/workspace");
    }
  });

  it("maps the canonical inner root agent to the workspace owner through rootless DinD", async () => {
    const dind = await readFile(resolve(workspaceRoot, ".dim/agent-dind/Dockerfile"), "utf8");
    const compose = await readFile(resolve(workspaceRoot, ".dim/docker-compose.yml"), "utf8");
    const setup = await readFile(resolve(workspaceRoot, ".dim/setup.sh"), "utf8");
    const agent = await readFile(resolve(workspaceRoot, ".dim/agent-dind/agent.sh"), "utf8");
    expect(dind).toContain("FROM docker:29.1.3-dind-rootless");
    expect(dind).toContain("chown root:root /usr/bin/newuidmap /usr/bin/newgidmap");
    expect(compose).toContain('DIM_UID: "${DIM_WORKSPACE_UID:-1000}"');
    expect(setup).toContain('integrated_root="$DIM_WORKSPACE_DATA/workspace"');
    expect(setup).toContain('DIM_WORKSPACE_UID="$(stat -c %u "$integrated_root")"');
    expect(setup).toContain("export COMPOSE_BAKE=false");
    expect(setup).toContain("verify_idmap_helpers agent-dind");
    expect(setup).toContain("verify_idmap_helpers secure-dind");
    expect(setup).toContain('test "$identity" = 0:0:4755');
    expect(setup.indexOf("compose build --quiet agent-dind")).toBeLessThan(
      setup.indexOf("verify_idmap_helpers agent-dind")
    );
    expect(setup.indexOf("compose build --quiet secure-dind")).toBeLessThan(
      setup.indexOf("verify_idmap_helpers secure-dind")
    );
    expect(agent).toContain("--user 0:0");
    expect(agent).toContain('stat -c %u /workspace)" = 0');
  });

  it("isolates outer Docker configuration from the workspace user home", async () => {
    for (const path of [
      ".dim/setup.sh",
      ".dim/teardown.sh",
      ".dim/home-archive.sh",
      ".dim/entrypoint.sh"
    ]) {
      const script = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(script).toContain('DOCKER_CONFIG="/tmp/dim-workspace-docker-config-$(id -u)"');
    }
  });

  it("keeps the inner Compose identity independent of the workspace name", async () => {
    const lifecycleTypes = await readFile(resolve(workspaceRoot, "core/packages/core/src/workspaceLifecycleTypes.ts"), "utf8");
    const projectCommands = await readFile(
      resolve(workspaceRoot, "core/packages/core/src/workspaceProjectCommands.ts"),
      "utf8"
    );
    expect(lifecycleTypes).toContain('const PROJECT_COMPOSE_NAME = "dim-project"');
    expect(projectCommands).toContain('`COMPOSE_PROJECT_NAME=${PROJECT_COMPOSE_NAME}`');
    expect(projectCommands).not.toContain('`COMPOSE_PROJECT_NAME=${record.composeProjectName}`');
  });

  it("verifies volume-preserving host shutdown and restore", async () => {
    const lifecycle = await readFile(
      resolve(workspaceRoot, "core/packages/core/src/hostLifecycle.ts"),
      "utf8"
    );
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/stateful-development-flow-smoke.bash"),
      "utf8"
    );
    expect(lifecycle).toContain("resumeWorkspaces");
    expect(lifecycle).toContain("restartCiRunners");
    expect(lifecycle).toContain("resumeManagedContainers");
    expect(lifecycle).not.toMatch(/docker[^\n]*(?:volume rm|container rm|\brm\b)/);
    expect(smoke).toContain("dim host shutdown");
    expect(smoke).toContain("volumes_before=");
    expect(smoke).toContain("dim host start");
  });

  it("uses serialized workspace resource names in verification smokes", async () => {
    for (const path of [
      "verification/scripts/container-self-project-smoke.bash",
      "verification/scripts/stateful-development-flow-smoke.bash"
    ]) {
      const smoke = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(smoke).toContain("jq -er .containerName");
      expect(smoke).toContain("jq -er .dockerVolumeName");
      expect(smoke).not.toContain("dim-ws-$workspace_name");
    }
  });

});
