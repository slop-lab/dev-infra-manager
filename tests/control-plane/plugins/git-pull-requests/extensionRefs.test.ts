import { expect, it } from "vitest";
import { repositoryOwnedRefs } from "../../../../packages/control-plane/plugins/git-repositories/src/extension-refs.js";
it("accepts only exact commit declarations inside each trusted owner's namespace", async () => {
  const scope = { projectId: "project", repositoryId: "main" };
  const ref = "refs/dim/extensions/git-pull-requests/uuid/revisions/revision/head";
  const commit = "a".repeat(40);
  expect(await repositoryOwnedRefs("/private", [{ name: "git-pull-requests", async ownedRefs(path, selector) { expect(path).toBe("/private/.extensions/git-pull-requests"); expect(selector).toEqual(scope); return [{ ref, commit }]; } }])(scope)).toEqual([{ ref, commit }]);
  for (const foreign of ["refs/heads/main", "refs/dim/extensions/other/id/head", "refs/dim/extensions/git-pull-requests/../main", "refs/dim/extensions/git-pull-requests/.hidden", "refs/dim/extensions/git-pull-requests/id.lock"]) {
    await expect(repositoryOwnedRefs("/private", [{ name: "git-pull-requests", async ownedRefs() { return [{ ref: foreign, commit }]; } }])(scope)).rejects.toThrow(/ownership/);
  }
  await expect(repositoryOwnedRefs("/private", [{ name: "git-pull-requests", async ownedRefs() { return [{ ref, commit: "main" }]; } }])(scope)).rejects.toThrow(/ownership/);
});
