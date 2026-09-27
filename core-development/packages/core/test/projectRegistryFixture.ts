import type { ProjectRepositoryRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";

export function projectRepositoryFixture(
  alias: string,
  phase: "importing" | "ready"
): ProjectRepositoryRecord {
  return {
    alias, providerRepoId: `dim-example/${alias}`, owner: "dim-example",
    hostUrl: `http://127.0.0.1:3300/dim-example/${alias}.git`, workspaceUrl: `http://dim-gitea:3000/dim-example/${alias}.git`,
    phase, connections: [], protectedPatterns: [], protectionPhase: "pending",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}
