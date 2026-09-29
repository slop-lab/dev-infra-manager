import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("self-Project CI job image", () => {
  it("pins a job image with sed for pnpm-generated executable shims", async () => {
    const config: unknown = parse(await readFile(resolve(workspaceRoot, ".dim/ci/runner.yml"), "utf8"));
    const workload = {
      tools: expect.arrayContaining(["sed", "node", "git"]),
      image: expect.stringMatching(/^nixery\.dev\/.*\/gnused\/.*@sha256:[0-9a-f]{64}$/)
    };

    expect(config).toMatchObject({ workloads: { ordinary: workload, integration: workload } });
  });

  it("runs the exact candidate with nested KVM only in a guest-private Docker child", async () => {
    const integrationImage = "nixery.dev/shell/bash/coreutils/gnused/gawk/jq/findutils/gnugrep/perl/util-linux/diffutils/tini/qemu/cloud-utils/openssh/gnutar/gzip/curl/git/nodejs/python3/docker-client/just/socat@sha256:db4fdcd4ba76e74e65fdf9c62f42cc656bc54fa338511c245cd957640c572746";
    const config: unknown = parse(await readFile(resolve(workspaceRoot, ".dim/ci/runner.yml"), "utf8"));
    const workflow: unknown = parse(await readFile(resolve(workspaceRoot, ".gitea/workflows/verify.yml"), "utf8"));

    expect(config).toMatchObject({ workloads: { integration: { image: integrationImage } } });
    expect(workflow).toMatchObject({ jobs: { "monorepo-qemu": {
      "runs-on": "dim-qemu",
      steps: expect.arrayContaining([expect.objectContaining({
        name: "Verify the complete candidate in disposable nested KVM",
        env: expect.objectContaining({
          DIM_CANDIDATE_SHA: "${{ gitea.sha }}",
          DIM_QEMU_JOB_IMAGE: integrationImage
        }),
        run: expect.stringContaining("docker create --device=/dev/kvm")
      })])
    } } });
  });
});
