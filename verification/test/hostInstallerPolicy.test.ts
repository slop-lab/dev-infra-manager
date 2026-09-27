import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("Ubuntu host installer policy", () => {
  it("installs the Buildx plugin required by Project image builds", async () => {
    // Given
    const installer = await readFile(resolve(workspaceRoot, "verification/scripts/install-host-ubuntu.bash"), "utf8");

    // When / Then
    expect(installer).toMatch(/^\s*- install common APT packages:[^\n]*\bdocker-buildx\b/m);
    expect(installer).toMatch(/^\s*sudo apt-get install -y[^\n]*\bdocker-buildx\b/m);
  });
});
