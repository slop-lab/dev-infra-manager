import { describe, expect, it } from "vitest";
import { createNonGitWorkbench } from "./harness.js";

describe("non-Git workbench harness", () => {
  it("serves an isolated authenticated console with synthetic host state", async () => {
    const fixture = await createNonGitWorkbench();
    try {
      const health = await fetch(`${fixture.origin}/healthz`);
      expect(health.status).toBe(200);
      expect(fixture.capabilities.syntheticHosts).toEqual(["local", "remote", "offline"]);
      expect(fixture.capabilities.realProtocols).toContain("DIM Web HTTP session and CSRF");
    } finally {
      await fixture.close();
    }
  });
});
