import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const statefulSmoke = resolve(import.meta.dirname, "../scripts/stateful-development-flow-smoke.bash");

describe("stateful development flow reviewed root", () => {
  it("adopts the immutable reviewed root while preserving the dirty mutable checkout", async () => {
    const smoke = await readFile(statefulSmoke, "utf8");
    const fixtureStart = smoke.indexOf("install_stateful_setup_hook");
    const fixtureCommit = smoke.indexOf('git -C "$repositories/root" commit -m "add stateful journey hooks"');
    const fixture = smoke.slice(fixtureStart, fixtureCommit);
    const restartStart = smoke.indexOf("preserve Project-owned work across reviewed restart");
    const restartEnd = smoke.indexOf("survive stop/start and controller replacement", restartStart);
    const restart = smoke.slice(restartStart, restartEnd);

    expect(fixture).toContain("reviewed-v1");
    expect(fixture).toContain("add .dim reviewed-version.txt");
    expect(restart).toContain('cat "$DIM_PROJECT_ROOT/reviewed-version.txt"');
    expect(restart).toContain('cat "$DIM_WORKSPACE_DATA/project/reviewed-version.txt"');
    expect(restart).toContain("cat /workspace/reviewed-version.txt");
    expect(restart).toContain('grep -q "dirty journey probe" ops/secret-service.sh');
    expect(restart).toContain("test -f journey-untracked");
    expect(restart).not.toMatch(/git\s+(?:reset|clean|checkout)/);
  });
});
