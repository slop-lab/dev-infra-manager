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

  it("runs the same full-development contract for every QEMU backend", async () => {
    const kvm = await readFile(resolve(workspaceRoot, "verification/scripts/kvm-host-install-smoke.bash"), "utf8");
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");
    const workflow = await readFile(resolve(workspaceRoot, "verification/.gitea/workflows/repository-set.yml"), "utf8");
    expect(kvm).not.toContain('if [[ "$backend" == runc ]]');
    expect(kvm).toContain("just verify full-development '$backend'");
    expect(kvm.indexOf("pnpm --filter @slop-lab/dim-controller-proxy run build")).toBeLessThan(
      kvm.indexOf('run_step "install $backend backend"')
    );
    expect(recipes).toContain('DIM_EXAMPLE_WORKSPACE_BACKEND="{{backend}}"');
    expect(recipes).toContain('DIM_SELF_WORKSPACE_BACKEND="{{backend}}"');
    expect(workflow.match(/with-ci-registry-cache\.bash/g)).toHaveLength(2);
  });

  it("materializes the complete rootless-Podman workspace image", async () => {
    const ignore = await readFile(resolve(workspaceRoot, ".dockerignore"), "utf8");
    const dockerfile = await readFile(resolve(workspaceRoot, "core/images/project-workspace-podman/Dockerfile"), "utf8");
    expect(ignore).toContain("!core/images/project-workspace-podman/**");
    expect(dockerfile).toContain("node-v24.19.0-linux-x64.tar.xz");
    expect(dockerfile).toContain("/usr/local/bin/dim-controller-proxy");
    expect(dockerfile).toContain("ln -s /usr/bin/podman /usr/local/bin/docker");
  });

  it("keeps example Compose files compatible with Podman Compose", async () => {
    for (const path of [
      "examples/projects/full-development-flow/repos/root/.dim/docker-compose.yml",
      "examples/projects/single-repository/repos/app/.dim/docker-compose.yml",
      "examples/projects/multi-repository/repos/root/.dim/docker-compose.yml"
    ]) {
      const compose = parse(await readFile(resolve(workspaceRoot, path), "utf8"));
      expect(compose.networks).toHaveProperty("default");
    }
    const stateful = await readFile(
      resolve(workspaceRoot, "verification/scripts/stateful-development-flow-smoke.bash"), "utf8"
    );
    expect(stateful).not.toContain("ps --all");
  });

  it("limits gVisor host socket access to opening reviewed mounted endpoints", async () => {
    const installer = await readFile(
      resolve(workspaceRoot, "verification/scripts/install-runsc-linux.bash"), "utf8"
    );
    expect(installer).toContain('"--host-uds=open"');
    expect(installer).not.toContain("--host-uds=all");
  });
});
