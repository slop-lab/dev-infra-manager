import { afterEach, expect, it } from "vitest";
import { finalizedWorkspaceWriteFixture, issueWorkspaceWriteLease, basicAuthorization } from "./nativeProjectWorkspaceWriteLeaseFixture.js";
import { cleanupFinalizeFixtures } from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

it("serves workspace Git discovery while a mutation of that repository is held", async () => {
  // Given a live writer lease and a deliberately held repository mutation.
  const fixture = await finalizedWorkspaceWriteFixture("read-bypasses-mutation");
  const lease = await issueWorkspaceWriteLease(fixture.service.origin);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = fixture.service.context.mutate({ projectId: "project-a", repositoryId: "root" }, async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  try {
    // When the writer asks for read-only receive-pack advertisement.
    const response = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: basicAuthorization(lease.username, lease.password) }, signal: AbortSignal.timeout(5_000)
    });
    // Then the real Git HTTP backend responds without releasing the mutation.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("# service=git-receive-pack");
  } finally { release.resolve(); await held; }
});
