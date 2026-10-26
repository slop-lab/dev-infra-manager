import { describe, expect, it } from "vitest";
import { createNonGitWorkbench } from "./harness.js";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
  it("does not rewrite synthetic state when reading tool and route status", async () => {
    const fixture = await createNonGitWorkbench();
    try {
      const state = join(fixture.root, "state.json"), before = await stat(state, { bigint: true });
      const input = JSON.stringify({ workspace: "studio", workspaceId: "17094660-a627-4a17-acd2-6418c0b79967" });
      for (const [domain, operation] of [["tools", "server.status"], ["external-url", "routes.list"]] as const) {
        await promisify(execFile)(join(fixture.root, "dim-fixture"), ["--host", "local", domain, "console", "invoke", operation, "--input", input, "--json"]);
      }
      expect((await stat(state, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    } finally { await fixture.close(); }
  });
});
