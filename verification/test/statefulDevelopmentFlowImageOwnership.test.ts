import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const statefulSmoke = resolve(import.meta.dirname, "../scripts/stateful-development-flow-smoke.bash");

describe("stateful development flow image ownership", () => {
  it("uses the private agent daemon's setup-seeded Alpine image", async () => {
    const smoke = await readFile(statefulSmoke, "utf8");
    const imageOwnershipCheck = smoke.indexOf(
      "workspace_compose exec --no-TTY agent-dind docker image inspect alpine:3.22"
    );
    const agentImageUse = smoke.indexOf('docker run --rm alpine:3.22 true', imageOwnershipCheck);

    expect(imageOwnershipCheck).toBeGreaterThan(-1);
    expect(agentImageUse).toBeGreaterThan(imageOwnershipCheck);
    expect(smoke).not.toContain("docker image save alpine:3.22");
  });
});
