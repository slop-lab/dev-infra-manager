import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { managedGitPluginEntries } from "../../../packages/control-plane/deployment/src/composition.js";
import { idleNativeConfig } from "../plugins/git-repositories/bundleConfigFixture.js";
import { basic, fixture, generationId, reviewer } from "../plugins/git-repositories/optionalFeaturesFixture.js";

it("accepts manifest synchronization policy in the managed preset without granting operator authority", async () => {
  const entries = managedGitPluginEntries({ config: idleNativeConfig(), stateDirectory: "/var/lib/dim-test",
    readinessToken: "readiness", activationToken: "activation", expectedGenerationId: generationId });
  const sync = entries.find(({ plugin }) => plugin.name === "git-sync");
  expect(sync).toBeDefined();
  expect(sync!.config).toEqual({ operators: [] });
  const prepared = await sync!.plugin.configure(sync!.config);
  const f = await fixture(true, prepared.extensions ?? [], { requiredReviewerIds: [], pathReviewerRules: [] }, [reviewer],
    { "git-sync": { upstream: { url: "https://github.com/octocat/Hello-World.git", branch: "master" }, publish: { main: "master" } } });
  try {
    // Fixture creation imports a protected root using the selected preset's policy extension.
    expect(f.initial).toMatch(/^[a-f0-9]{40}$/);
    const identity = await fetch(`${f.origin}/v1/git-sync-operator-identity`, { headers: { authorization: basic(reviewer) } });
    expect(identity.status).toBe(403);
    const publish = await fetch(`${f.origin}/v1/projects/project/repositories/main/sync/publish`, { method: "POST",
      headers: { authorization: basic(reviewer), "content-type": "application/json", "x-dim-generation-id": generationId }, body: '{"schemaVersion":1}' });
    expect(publish.status).toBe(403);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
