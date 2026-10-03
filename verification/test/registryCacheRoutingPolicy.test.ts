import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const verificationRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(verificationRoot, "..");
const routingLibrary = resolve(verificationRoot, "scripts/lib/registry-cache-routing.bash");
const smokeScript = resolve(verificationRoot, "scripts/registry-cache-routing-smoke.bash");
const nestedSmokeScript = resolve(verificationRoot, "scripts/registry-cache-routing-nested-smoke.bash");
const managedSmokeScript = resolve(verificationRoot, "scripts/registry-cache-routing-managed-smoke.bash");
const journeyLibrary = resolve(verificationRoot, "scripts/lib/registry-cache-routing-journey.bash");

describe("registry cache routing shell contracts", () => {
  it("keeps the Docker smoke isolated, self-cleaning, and wired as a separate target", async () => {
    // Given
    const recipes = await readFile(resolve(verificationRoot, "verify.just"), "utf8");
    const smoke = await readFile(smokeScript, "utf8");

    // When
    const syntax = spawnSync("bash", ["-n", smokeScript]);
    const librarySyntax = spawnSync("bash", ["-n", routingLibrary]);

    // Then
    expect(syntax.status).toBe(0);
    expect(librarySyntax.status).toBe(0);
    expect(recipes).toContain("cache-routing-docker:");
    expect(recipes).toContain("registry-cache-routing-smoke.bash --docker-only");
    expect(smoke.indexOf("trap cleanup EXIT")).toBeLessThan(smoke.indexOf("docker network create"));
    expect(smoke).toContain("registry-1.docker.io:127.0.0.1");
    expect(smoke).toContain("auth.docker.io:127.0.0.1");
    expect(smoke).toContain('address_reservation="dim-cache-routing-address-reservation-$run_id"');
    expect(smoke).toContain('[[ "$replacement_cache_address" != "$previous_cache_address" ]]');
    expect(smoke).toContain('docker exec "$client" docker pull "$cold_ref" >"$root/replacement-pull.log" 2>&1');
    expect(smoke).not.toMatch(/(?:--publish|-p)[ =]/);
    expect(smoke).not.toContain("/var/run/docker.sock:");
  });

  it("maintains a two-level Docker surrogate for the workspace-local agent relay", async () => {
    const recipes = await readFile(resolve(verificationRoot, "verify.just"), "utf8");
    const nestedSmoke = await readFile(nestedSmokeScript, "utf8");
    const syntax = spawnSync("bash", ["-n", nestedSmokeScript]);

    expect(syntax.status).toBe(0);
    expect(recipes).toContain("registry-cache-routing-nested-smoke.bash --docker-only");
    expect(nestedSmoke).toContain('network="dim-control"');
    expect(nestedSmoke).toContain('cache="dim-registry-cache"');
    expect(nestedSmoke).toContain("--network-alias");
    expect(nestedSmoke).toContain("dim-registry-cache:5000");
    expect(nestedSmoke).toContain("host.docker.internal:host-gateway");
    expect(nestedSmoke).toContain("--registry-mirror=http://host.docker.internal:5000");
    expect(nestedSmoke).toContain('docker image tag "$dind_image" "$agent_image"');
    expect(nestedSmoke).toContain('docker image rm "$agent_image"');
    expect(nestedSmoke).toContain('--entrypoint dockerd "$agent_image"');
    expect(nestedSmoke).toContain("registry-1.docker.io:127.0.0.1");
    expect(nestedSmoke).toContain("auth.docker.io:127.0.0.1");
    expect(nestedSmoke).toContain('[[ "$replacement_cache_address" != "$previous_cache_address" ]]');
    expect(nestedSmoke).toContain("outage_upstream_requests");
    expect(nestedSmoke).not.toContain("--publish");
    expect(nestedSmoke).not.toMatch(/docker (?:run|create)[^\n]* -p(?:[ =]|$)/);
    expect(nestedSmoke).not.toContain("/var/run/docker.sock:");
  });

  it("initializes fixture routes before deriving paths under nounset", async () => {
    // Given
    const scripts = await Promise.all([nestedSmokeScript, managedSmokeScript].map((script) => readFile(script, "utf8")));

    // When
    const sameDeclarationReferences = scripts.map((script) => script.match(/local route="\$1"[^\n]*\$route/));

    // Then
    expect(sameDeclarationReferences).toEqual([null, null]);
  });

  it("wires managed Sysbox and KVM routes through production journeys", async () => {
    // Given
    const recipes = await readFile(resolve(verificationRoot, "verify.just"), "utf8");

    // When
    const managedSmoke = await readFile(managedSmokeScript, "utf8");
    const journeyHooks = await readFile(journeyLibrary, "utf8");

    // Then
    expect(recipes).toContain("cache-routing-sysbox:");
    expect(recipes).toContain("cache-routing-kvm:");
    expect(managedSmoke).toContain("stateful-development-flow-smoke.bash");
    expect(managedSmoke).toContain("ci-runner-example-smoke.bash");
    expect(managedSmoke).toContain("qemu-verify.bash");
    expect(managedSmoke).toContain("--cache-routing");
    expect(journeyHooks).toContain("DIM_CACHE_ROUTING_REF");
    expect(managedSmoke).toContain("managed_routes=(workspace agent-dind sysbox-runner)");
    expect(managedSmoke).toContain("managed_routes=(qemu)");
    expect(journeyHooks).toContain("dim_cache_routing_select_route workspace");
    expect(journeyHooks).toContain("dim_cache_routing_select_route agent-dind");
    expect(journeyHooks).toContain("dim_cache_routing_select_route sysbox-runner");
    expect(managedSmoke).toContain("DIM_DOCKER_REGISTRY_MIRROR=http://host.docker.internal:5000");
    expect(managedSmoke.match(/with-ci-registry-cache\.bash/g)).toHaveLength(1);
    expect(managedSmoke).toContain('with-ci-registry-cache.bash" --qemu-relay');
    expect(managedSmoke).not.toContain("--bind-address 0.0.0.0");
  });

  it("keeps managed daemons on direct cache discovery and QEMU on its launcher relay", async () => {
    const registryCache = await readFile(resolve(workspaceRoot, "core/packages/core/src/registryCache.ts"), "utf8");
    const workspaceContainer = await readFile(
      resolve(workspaceRoot, "core/packages/core/src/workspaceContainer.ts"),
      "utf8"
    );
    const sysboxRunner = await readFile(resolve(workspaceRoot, "core/packages/core/src/sysboxCiRunnerLifecycle.ts"), "utf8");
    const qemuRunner = await readFile(resolve(workspaceRoot, "core/packages/core/src/qemuCiRunnerLifecycle.ts"), "utf8");
    const qemuSupervisor = await readFile(resolve(workspaceRoot, "core/packages/core/src/qemuCiRunnerSupervisorAssets.ts"), "utf8");

    expect(registryCache).toContain('REGISTRY_CACHE_ENDPOINT = `${REGISTRY_CACHE_CONTAINER}:5000`');
    expect(registryCache).toContain('"--network-alias", REGISTRY_CACHE_CONTAINER');
    expect(workspaceContainer).toContain('`DIM_REGISTRY_CACHE_ENDPOINT=${REGISTRY_CACHE_ENDPOINT}`');
    expect(sysboxRunner).toContain('`DIM_CI_REGISTRY_CACHE_UPSTREAM=${REGISTRY_CACHE_ENDPOINT}`');
    expect(qemuRunner).toContain('`DIM_CI_REGISTRY_CACHE_UPSTREAM=${REGISTRY_CACHE_ENDPOINT}`');
    expect(qemuSupervisor).toContain('socat "TCP-LISTEN:$registry_relay_port,fork,reuseaddr" "TCP:$registry_cache_upstream"');
    expect(qemuSupervisor).toContain('"registry-mirrors": ["http://10.0.2.2:$registry_relay_port"]');
  });

  it("keeps capability-gated Sysbox routing local while preserving hosted KVM lanes", async () => {
    const integration = parse(await readFile(resolve(verificationRoot, ".gitea/workflows/integration.yml"), "utf8"));
    const repositorySet = await readFile(resolve(verificationRoot, ".gitea/workflows/repository-set.yml"), "utf8");
    const recipes = await readFile(resolve(verificationRoot, "verify.just"), "utf8");
    const managedSmoke = await readFile(managedSmokeScript, "utf8");

    expect(integration.on.workflow_dispatch.inputs.lane.options).not.toContain("cache-routing-sysbox");
    expect(integration.jobs).not.toHaveProperty("cache-routing-sysbox");
    expect(integration.jobs["cache-routing-kvm"].with).toMatchObject({
      gate: "cache-routing-kvm",
      "runner-label": "dim-qemu"
    });
    expect(integration.jobs["qemu-ci-image-layers-kvm"].with).toMatchObject({
      gate: "qemu-ci-image-layers-kvm",
      "runner-label": "dim-qemu"
    });
    for (const recipe of ["cache-routing-sysbox", "cache-routing-kvm", "qemu-ci-image-layers-kvm"]) {
      expect(repositorySet).toContain(`just verify ${recipe}`);
    }
    expect(recipes).toContain("cache-routing-sysbox:");
    expect(recipes).toContain("registry-cache-routing-managed-smoke.bash --sysbox");
    expect(managedSmoke).toContain("docker info --format '{{json .Runtimes}}' | grep -q '\"sysbox-runc\"'");
    expect(recipes).toContain("qemu-ci-image-layers-kvm requires x86-64");
    expect(recipes).toContain("qemu-ci-image-layers-kvm requires an accessible character /dev/kvm");
  });

  it("keeps registry routing hooks opt-in and blocks direct fallback inside nested verification", async () => {
    // Given
    const stateful = await readFile(resolve(verificationRoot, "scripts/stateful-development-flow-smoke.bash"), "utf8");
    const runner = await readFile(resolve(verificationRoot, "scripts/ci-runner-example-smoke.bash"), "utf8");
    const mirror = await readFile(resolve(verificationRoot, "scripts/lib/test-registry-mirror.bash"), "utf8");
    const relay = await readFile(resolve(verificationRoot, "scripts/with-ci-registry-cache.bash"), "utf8");
    const journeyHooks = await readFile(journeyLibrary, "utf8");

    // When
    const syntax = [
      resolve(verificationRoot, "scripts/stateful-development-flow-smoke.bash"),
      resolve(verificationRoot, "scripts/ci-runner-example-smoke.bash"),
      resolve(verificationRoot, "scripts/lib/test-registry-mirror.bash"),
      resolve(verificationRoot, "scripts/with-ci-registry-cache.bash"),
      managedSmokeScript,
      journeyLibrary
    ]
      .map((script) => spawnSync("bash", ["-n", script]));

    // Then
    expect(syntax.every((result) => result.status === 0)).toBe(true);
    expect(stateful).toContain("dim_cache_routing_workspace_routes");
    expect(runner).toContain("dim_cache_routing_runner_ready");
    expect(runner).toContain("dim_cache_routing_runner_outage");
    expect(mirror).toContain('"registry-1.docker.io:127.0.0.1"');
    expect(mirror).toContain('"auth.docker.io:127.0.0.1"');
    expect(mirror).toContain("/usr/local/lib/dim/route-relay.mjs");
    expect(mirror).toContain('DIM_REGISTRY_CACHE_ENDPOINT:?');
    expect(mirror).toContain("/tmp/dim-ci-registry-cache-relay.pid");
    expect(journeyHooks).toContain("/tmp/dim-ci-registry-cache-relay.pid");
    expect(journeyHooks).not.toContain("DIM_CI_REGISTRY_CACHE_RELAY_PID");
    expect(relay).toContain('[[ "${1:-}" == --qemu-relay ]]');
    expect(relay).not.toContain("DIM_DOCKER_REGISTRY_MIRROR");
    expect(relay).toContain("DIM_CI_REGISTRY_CACHE_RELAY_PID");
  });
});
