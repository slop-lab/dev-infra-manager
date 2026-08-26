import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM development forge policy", () => {
  it("pins every split repository to its reviewed development and publish ref", async () => {
    const manifest = parse(await readFile(resolve(workspaceRoot, "project/.dim/repos.yml"), "utf8"));
    const expected = [
      "root", "development", "core", "core-development",
      "plugin-dns-cloudflare", "plugin-dns-cloudflare-development",
      "plugin-external-urls", "plugin-external-urls-development",
      "verification", "examples", "specification"
    ];

    expect(manifest?.schemaVersion).toBe(1);
    const archiveUrl = process.env.DIM_EXPECT_ARCHIVE_URL ??
      "https://github.com/slop-lab/dev-infra-manager.git";
    expect(manifest.upstreams).toEqual({ archive: { url: archiveUrl } });
    expect(Object.keys(manifest.repositories).sort()).toEqual(expected.sort());
    for (const alias of expected) {
      const repository = manifest.repositories[alias];
      const externalRef = `dev/${alias}`;
      expect(repository.upstream).toBe("archive");
      expect(repository.import).toEqual({ main: externalRef });
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
    const kvm = await readFile(resolve(workspaceRoot, "verification/scripts/kvm-host-install-smoke.bash"), "utf8");
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");
    const workflow = await readFile(resolve(workspaceRoot, "verification/.gitea/workflows/repository-set.yml"), "utf8");
    expect(kvm).toContain('backend="sysbox"');
    expect(kvm).toContain("just verify full-development");
    expect(kvm).toContain('2>&1 | tee "$step_log"');
    expect(kvm.indexOf("pnpm --filter @slop-lab/dim-controller-proxy run build")).toBeLessThan(
      kvm.indexOf('run_step "install $backend backend"')
    );
    expect(recipes).toContain("DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox");
    expect(recipes).toContain("DIM_SELF_WORKSPACE_BACKEND=sysbox");
    expect(workflow.match(/with-ci-registry-cache\.bash/g)).toHaveLength(2);
    expect(workflow.match(/DIM_TEST_PTY_RESIZE: unsupported/g)).toHaveLength(2);
    expect(workflow).toContain("inputs.gate == 'kvm' && 60 || 30");
    expect(workflow).toContain("inputs.gate != 'integration' && inputs.gate != 'container'");
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

  it("maps the canonical inner root agent to the workspace owner through rootless DinD", async () => {
    const dind = await readFile(resolve(workspaceRoot, "project/.dim/agent-dind/Dockerfile"), "utf8");
    const compose = await readFile(resolve(workspaceRoot, "project/.dim/docker-compose.yml"), "utf8");
    const setup = await readFile(resolve(workspaceRoot, "project/.dim/setup.sh"), "utf8");
    const agent = await readFile(resolve(workspaceRoot, "project/.dim/agent-dind/agent.sh"), "utf8");
    expect(dind).toContain("FROM docker:29.1.3-dind-rootless");
    expect(compose).toContain('DIM_UID: "${DIM_WORKSPACE_UID:-1000}"');
    expect(setup).toContain('DIM_WORKSPACE_UID="$(stat -c %u /workspace)"');
    expect(agent).toContain("--user 0:0");
    expect(agent).toContain('stat -c %u /workspace)" = 0');
  });
});
