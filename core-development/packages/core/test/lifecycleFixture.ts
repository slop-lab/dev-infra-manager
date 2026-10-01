export function rootRepositorySnapshot(commit: string, workspaceUrl = "http://workspace/root.git") {
  return {
    root: {
      workspaceUrl,
      phase: "ready" as const,
      root: true as const,
      requestedRef: "refs/heads/main",
      ref: "refs/heads/main",
      commit
    }
  };
}
