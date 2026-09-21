import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("self-development rootless persistence policy", () => {
  it("preserves persistent agent-home ownership and modes during setup", async () => {
    const agent = await readFile(resolve(workspaceRoot, "project/.dim/agent-dind/agent.sh"), "utf8");

    expect(agent).not.toMatch(/chown[^\n]*\/mnt\/agent-home/);
  });

  it("rejects incompatible persistent roots without recursively rewriting them", async () => {
    const entrypoints = await Promise.all(
      ["agent-dind", "secure-dind"].map((service) =>
        readFile(resolve(workspaceRoot, `project/.dim/${service}/entrypoint.sh`), "utf8")
      )
    );

    for (const entrypoint of entrypoints) {
      expect(entrypoint).not.toMatch(/chown\s+-R/);
      expect(entrypoint).toContain("incompatible ownership");
      expect(entrypoint).not.toContain("runtime-runc");
      expect(entrypoint).not.toMatch(/rm\s+-rf/);
    }
  });

  it("repairs and preserves setuid ownership for rootless idmap helpers", async () => {
    const entrypoints = await Promise.all(
      ["agent-dind", "secure-dind"].map((service) =>
        readFile(resolve(workspaceRoot, `project/.dim/${service}/entrypoint.sh`), "utf8")
      )
    );

    for (const entrypoint of entrypoints) {
      expect(entrypoint).toContain("chown root:root /usr/bin/newuidmap /usr/bin/newgidmap");
      expect(entrypoint).toContain("chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap");
    }
  });
});
