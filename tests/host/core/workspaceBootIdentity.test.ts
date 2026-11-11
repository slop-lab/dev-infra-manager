import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { ProcessRunner } from "@slop-lab/dim-host-core/workspace";
import { verifyWorkspaceBootIdentity } from "../../../packages/host/core/src/application/workspace-boot-identity.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

it("accepts the real Linux boot identity through the guest execution surface", async () => {
  // Given a real process, rather than an identity response mock.
  const runner = new ProcessRunner(), workspace = workspaceRecord();
  // When the guest probe executes on this Linux environment.
  await verifyWorkspaceBootIdentity(workspace, {
    signal: new AbortController().signal,
    service: { exec: async (_name, command, options) => {
      expect(options?.workspaceId).toBe(workspace.id);
      return runner.runStreaming(command[0] ?? "", command.slice(1), options);
    } }
  });
  // Then successful completion means the actual read and format check passed.
});

it.each(["ENOTCONN", "EACCES", "INVALID_BOOT_ID", "TIMEOUT"])("reports %s as runtime identity failure, not cache repair", async (code) => {
  // Given a probe response at the guest execution boundary.
  const workspace = workspaceRecord();
  // When the runtime cannot establish boot identity.
  const result = verifyWorkspaceBootIdentity(workspace, {
    signal: new AbortController().signal,
    service: { exec: async (_name, _command, options) => {
      if (!(options?.stdout instanceof Writable)) throw new Error("expected bounded output sink");
      options.stdout.write(`boot-identity:${code}`);
      return 1;
    } }
  });
  // Then the diagnostic retains exact identity and forbids automatic recovery.
  await expect(result).rejects.toThrow(new RegExp(`${workspace.id}.*boot_id.*${code}`));
  await expect(result).rejects.toThrow(/main sessions, subagents and teams/);
});
