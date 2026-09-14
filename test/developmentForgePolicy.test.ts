import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM development forge policy", () => {
  it("gives local install bundles a source-specific package version", async () => {
    const localPack = await readFile(
      resolve(workspaceRoot, "verification/scripts/pack-local-packages.bash"),
      "utf8"
    );
    expect(localPack).toContain("repositories=(core plugin-dns-cloudflare plugin-external-urls)");
    expect(localPack).toContain("GIT_MASTER=1 git -C");
    expect(localPack).toContain("rev-parse HEAD");
    expect(localPack).not.toContain("rev-parse --short");
    expect(localPack).toContain("sha256sum");
    expect(localPack).toContain("DIM_LOCAL_BUILD_VERSION");

    const sourcePack = await readFile(resolve(workspaceRoot, "project/scripts/pack-source-build.bash"), "utf8");
    expect(sourcePack).toContain("git -C");
    expect(sourcePack).toContain("rev-parse HEAD");
    for (const variable of [
      "DIM_SOURCE_CORE_COMMIT",
      "DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT",
      "DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT"
    ]) {
      expect(sourcePack).toContain(variable);
    }
    expect(sourcePack).toContain("sha256sum");
    expect(sourcePack).toContain("DIM_LOCAL_BUILD_VERSION");
    expect(sourcePack).toContain("-local-");
    expect(sourcePack).toContain("-dirty");
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

  it("pins every split repository to its standalone upstream and main branch", async () => {
    const manifest = parse(await readFile(resolve(workspaceRoot, "project/.dim/repos.yml"), "utf8"));
    const expectedUpstreams = {
      root: "https://gitlab.com/slop-lab/dim/root.git",
      development: "https://gitlab.com/slop-lab/dim/essential-dev/root.git",
      core: "https://gitlab.com/slop-lab/dim/essential/core.git",
      "core-development": "https://gitlab.com/slop-lab/dim/essential-dev/core.git",
      "plugin-dns-cloudflare": "https://gitlab.com/slop-lab/dim/essential/plugin-dns-cloudflare.git",
      "plugin-dns-cloudflare-development":
        "https://gitlab.com/slop-lab/dim/essential-dev/plugin-dns-cloudflare.git",
      "plugin-external-urls": "https://gitlab.com/slop-lab/dim/essential/plugin-external-urls.git",
      "plugin-external-urls-development":
        "https://gitlab.com/slop-lab/dim/essential-dev/plugin-external-urls.git",
      verification: "https://gitlab.com/slop-lab/dim/dev/verification.git",
      examples: "https://gitlab.com/slop-lab/dim/dev/examples.git",
      specification: "https://gitlab.com/slop-lab/dim/dev/specification.git"
    };
    const expected = Object.keys(expectedUpstreams);

    expect(manifest?.schemaVersion).toBe(1);
    expect(manifest.upstreams).toEqual(
      Object.fromEntries(Object.entries(expectedUpstreams).map(([alias, url]) => [alias, { url }]))
    );
    expect(Object.keys(manifest.repositories).sort()).toEqual(expected.sort());
    for (const alias of expected) {
      const repository = manifest.repositories[alias];
      expect(repository.upstream).toBe(alias);
      expect(repository.import).toEqual({ main: "main" });
      expect(repository.publish).toEqual({ main: "main" });
      expect(repository.protect ?? []).toEqual(["root", "development"].includes(alias) ? ["main"] : []);
      expect(repository.ref).toBe("main");
      expect(repository.root).toBe(alias === "root" ? true : undefined);
    }
  });

  it("keeps persistent QEMU cache mutation in the protected root", async () => {
    const hook = resolve(workspaceRoot, "project/.dim/ci/qemu-cache.bash");
    expect(spawnSync("bash", ["-n", hook]).status).toBe(0);
    const source = await readFile(hook, "utf8");
    expect(source).toContain("noble-server-cloudimg-amd64.img");
    expect(source).toContain("6e40c07ae715f744f84af0bec76415cc1987dd115b4b8de437818561f01a3733");
    expect(source).toContain("sha256sum --check");
  });

  it("runs the full-development contract in the Sysbox QEMU lane", async () => {
    const gate = await readFile(resolve(workspaceRoot, "verification/scripts/kvm-host-install-smoke.bash"), "utf8");
    const kvm = await readFile(resolve(workspaceRoot, "project/.dim/qemu-verify.bash"), "utf8");
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");
    const workflow = await readFile(resolve(workspaceRoot, "verification/.gitea/workflows/repository-set.yml"), "utf8");
    expect(kvm).toContain('backend="sysbox"');
    expect(kvm).toContain("just verify full-development");
    expect(kvm).toContain('2>&1 | tee "$step_log"');
    expect(gate).toContain("project/.dim/qemu-service.mjs");
    expect(gate).toContain('node "$client" run');
    expect(kvm.indexOf("pnpm --filter @slop-lab/dim-controller-proxy run build")).toBeLessThan(
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
    const contract = parse(await readFile(resolve(workspaceRoot, "project/.dim/ci/runner.yml"), "utf8"));
    const expectedImage =
      "nixery.dev/shell/bash/coreutils/gnutar/gzip/curl/git/nodejs/python3/docker-client/just/socat@sha256:e191da897cdbfad45bb0f6a84e1d93d8628dabb9a1c2aa1c1897759d6b3078e3";
    expect(contract.schemaVersion).toBe(1);
    expect(Object.keys(contract.workloads).sort()).toEqual(["integration", "ordinary"]);
    expect(contract.workloads.ordinary.labels).toEqual(["dim"]);
    expect(contract.workloads.integration.labels).toEqual(["dim-container-integration"]);
    expect(contract.workloads.integration.capabilities).toEqual(["nested-docker"]);
    for (const workload of Object.values(contract.workloads) as Array<Record<string, unknown>>) {
      expect(workload.image).toBe(expectedImage);
      expect(workload.image).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(String(workload.image).split("@")[0]).not.toMatch(/:[^/]+$/);
      expect(workload.tools).toEqual(expect.arrayContaining(["bash", "git", "node", "python3"]));
    }
  });

  it("runs all managed workflow labels in disposable job containers", async () => {
    const workflowPaths = [
      "project/.gitea/workflows/verify.yml",
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
      "examples/projects/full-development-flow/repos/root/.dim/dind/Dockerfile",
      "examples/projects/single-repository/repos/app/.dim/dind/Dockerfile",
      "examples/projects/multi-repository/repos/root/.dim/dind/Dockerfile"
    ]) {
      const dockerfile = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(dockerfile).toContain("FROM docker:29.1.3-dind-rootless");
    }
  });

  it("mounts each example agent workspace from the lifecycle-provided mutable project root", async () => {
    for (const path of [
      "examples/projects/full-development-flow/repos/root/.dim/docker-compose.yml",
      "examples/projects/single-repository/repos/app/.dim/docker-compose.yml",
      "examples/projects/multi-repository/repos/root/.dim/docker-compose.yml"
    ]) {
      const compose = await readFile(resolve(workspaceRoot, path), "utf8");
      expect(compose).toContain("${DIM_PROJECT_ROOT:?}:/workspace");
      expect(compose).not.toContain("..:/workspace");
    }
  });

  it("maps the canonical inner root agent to the workspace owner through rootless DinD", async () => {
    const dind = await readFile(resolve(workspaceRoot, "project/.dim/agent-dind/Dockerfile"), "utf8");
    const compose = await readFile(resolve(workspaceRoot, "project/.dim/docker-compose.yml"), "utf8");
    const setup = await readFile(resolve(workspaceRoot, "project/.dim/setup.sh"), "utf8");
    const agent = await readFile(resolve(workspaceRoot, "project/.dim/agent-dind/agent.sh"), "utf8");
    expect(dind).toContain("FROM docker:29.1.3-dind-rootless");
    expect(dind).toContain("chown root:root /usr/bin/newuidmap /usr/bin/newgidmap");
    expect(compose).toContain('DIM_UID: "${DIM_WORKSPACE_UID:-1000}"');
    expect(setup).toContain('DIM_WORKSPACE_UID="$(stat -c %u /workspace)"');
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
      "project/.dim/setup.sh",
      "project/.dim/teardown.sh",
      "project/.dim/home-archive.sh",
      "project/.dim/entrypoint.sh"
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
