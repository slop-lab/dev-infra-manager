import { ownedWorkspaceName, SmokeFailure, type OwnedWorkspace } from "./config.js";
import type { CommandResult } from "../web-lifecycle/process.js";

/** Keep the workspace available for inspection whenever remote branch ownership is uncertain. */
export async function cleanupOwnedSmokeWorkspace(input: {
  readonly host: string;
  readonly owned: OwnedWorkspace;
  readonly branch?: { readonly ref: string; readonly commit: string };
  readonly run: (args: readonly string[], timeoutMs: number) => Promise<CommandResult>;
}): Promise<void> {
  const owned = ownedWorkspaceName(input.owned.name, input.owned);
  const fail = (detail: string): never => { throw new SmokeFailure(input.host, "owned cleanup", detail); };
  if (input.branch !== undefined) {
    const { ref, commit } = input.branch;
    if (!/^refs\/heads\/smoke\/[0-9a-f]{32}$/.test(ref) || !/^[0-9a-f]{40}$/.test(commit)) fail("branch ownership is invalid; workspace retained for operator inspection");
    const remote = await input.run(["exec", owned.name, "--", "git", "ls-remote", "--exit-code", "--refs", "origin", ref], 120_000);
    if (remote.exitCode === 0) {
      if (remote.stdout.trim() !== `${commit}\t${ref}`) fail("owned branch changed; branch and workspace retained for operator inspection");
      // The explicit lease protects the interval after ls-remote as well as Git's own ref discovery.
      const deleted = await input.run(["exec", owned.name, "--", "git", "push", `--force-with-lease=${ref}:${commit}`, "origin", `:${ref}`], 120_000);
      if (deleted.exitCode !== 0) fail("branch deletion was not confirmed; workspace retained for operator inspection");
    } else if (remote.exitCode !== 2) fail("remote branch ownership could not be inspected; workspace retained for operator inspection");
  }
  const discarded = await input.run(["discard", owned.name, "--yes", "--expect-id", owned.id, "--json"], 180_000);
  if (discarded.exitCode !== 0) fail("exact workspace discard was not confirmed; inspect this selected host interactively");
}
