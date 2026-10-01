import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

const examples = [
  "examples/projects/single-repository/repos/app/.dim",
  "examples/projects/multi-repository/repos/root/.dim",
  "examples/projects/full-development-flow/repos/root/.dim"
] as const;

describe("example agent runtime policy", () => {
  it.each(examples)("grants container-local sudo to the named nonroot agent in %s", async (path) => {
    // Given
    const dockerfile = await readFile(resolve(workspaceRoot, path, "agent/Dockerfile"), "utf8");

    // When
    const packageInstall = dockerfile.slice(dockerfile.indexOf("apt-get install"), dockerfile.indexOf("rm -rf /var/lib/apt/lists"));

    // Then
    expect(packageInstall).toMatch(/\bsudo\b/);
    expect(dockerfile).toMatch(/\b(?:useradd|usermod)\b[^\n]*\bdim-agent\b/);
    expect(dockerfile).toContain("dim-agent ALL=(root) NOPASSWD: ALL");
    expect(dockerfile).toContain("visudo --check --file=/etc/sudoers.d/dim-agent");
  });

  it.each(examples)("recreates the agent with managed Git host aliases in %s", async (path) => {
    // Given
    const setup = await readFile(resolve(workspaceRoot, path, "setup.sh"), "utf8");

    // When / Then
    expect(setup).toContain("DIM_PROJECT_MANIFEST");
    expect(setup).toContain(".hostAliases");
    expect(setup).toContain("extra_hosts");
    expect(setup).toMatch(
      /docker compose[\s\S]*?--file "\$compose_host_aliases"[\s\S]*?up[\s\S]*?--force-recreate/
    );
  });
});
