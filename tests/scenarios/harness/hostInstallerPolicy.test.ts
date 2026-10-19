import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

describe("Ubuntu host installer policy", () => {
  it("installs the Buildx plugin required by Project image builds", async () => {
    // Given
    const installer = await readFile(resolve(workspaceRoot, "scripts/checks/install-host-ubuntu.bash"), "utf8");

    // When / Then
    expect(installer).toMatch(/^\s*- install common APT packages:[^\n]*\bdocker-buildx\b/m);
    expect(installer).toMatch(/^\s*sudo apt-get install -y[^\n]*\bdocker-buildx\b/m);
  });

  it("keeps Docker CE packages and signing identity exact for VM bootstrap", async () => {
    // Given
    const installer = await readFile(resolve(workspaceRoot, "scripts/checks/lib/install-docker-ce-ubuntu.bash"), "utf8");
    const pins = await readFile(resolve(workspaceRoot, "scripts/lib/bootstrap-ubuntu-pins.bash"), "utf8");

    // When / Then
    expect(pins).toContain("dim_docker_package_version='5:29.1.4-1~ubuntu.24.04~noble'");
    expect(pins).toContain("dim_containerd_package_version='2.2.1-1~ubuntu.24.04~noble'");
    expect(pins).toContain("dim_buildx_package_version='0.31.1-1~ubuntu.24.04~noble'");
    expect(pins).toContain("dim_compose_package_version='2.40.3-1~ubuntu.24.04~noble'");
    expect(pins).toContain("dim_sysbox_package_version='0.7.0.linux'");
    expect(installer).toContain('source "$pins_helper"');
    expect(installer).toContain("9DC858229FC7DD38854AE2D88D81803C0EBFCD88");
    expect(installer).toContain("io.containerd.snapshotter.v1");
    expect(installer).not.toContain("daemon.json");
  });
});
