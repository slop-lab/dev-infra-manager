import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readNativeRepositoryPolicyFile } from "../../../../packages/host/plugins/native-git/src/cli/repository-policy-file.js";
import { compileNativeRepositoryBootstrapPolicy } from "../../../../packages/host/plugins/native-git/src/nativeRootBootstrapPolicy.js";

it("preserves explicit branch metadata from an operator JSON policy through compilation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-branch-policy-"));
  try {
    const path = join(root, "policy.json");
    const declaration = { schemaVersion: 1, repositoryId: "root", extensions: {}, defaultRef: "refs/heads/development",
      branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: true } } };
    await writeFile(path, JSON.stringify(declaration), { mode: 0o600 });
    const parsed = await readNativeRepositoryPolicyFile(path);
    const policy = compileNativeRepositoryBootstrapPolicy({ ...parsed, protectedRef: "refs/heads/main" }).repositoryPolicy;
    expect(policy.defaultRef).toBe(declaration.defaultRef);
    expect(policy.branches).toEqual(declaration.branches);
    await writeFile(path, JSON.stringify({ ...declaration, branches: { main: { review: true, forcePush: true } } }));
    await expect(readNativeRepositoryPolicyFile(path)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
