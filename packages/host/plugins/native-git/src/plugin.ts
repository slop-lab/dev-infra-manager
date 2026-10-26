import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { deployGuestIntegration } from "@slop-lab/dim-host-core/workspace";
import { readFile } from "node:fs/promises";
export const hostPlugin: WorkspaceHostPlugin = {
  name: "native-git",
  source: {
    schemes: ["dim"],
    async create(input, context) {
      const { createManagedWorkspace } = await import("./nativeWorkspaceHost.js");
      return createManagedWorkspace(input, context);
    },
    async ensure(workspace, context) {
      const { ensureManagedWorkspace } = await import("./nativeWorkspaceHost.js");
      await ensureManagedWorkspace(workspace, context);
    }
  },
  async workspaceMetadata(workspace, context) {
    if (!workspace.source.url.startsWith("dim://")) return;
    const { nativeWorkspaceMetadata } = await import("./nativeWorkspaceMetadata.js");
    return nativeWorkspaceMetadata(workspace, managedStateRoot(process.env), context.stateRoot);
  },
  async workspaceReady(workspace, context) {
    if (!workspace.source.url.startsWith("dim://")) return;
    await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
      name: "native-git-ci-helper", files: [{ path: ".local/bin/dim-ci", contents: await readFile(new URL("./guest/dim-ci.mjs", import.meta.url)), mode: 0o700 }],
    });
  },
  workspaceServices: {
    names: ["native-git"],
    async resolve(name, workspace, context) {
      if (name !== "native-git" || !workspace.source.url.startsWith("dim://")) return undefined;
      const { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment } = await import("./nativeWorkspaceAttachment.js");
      const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(managedStateRoot(process.env), workspace.id));
      if (attachment.workspaceName !== workspace.name || attachment.workspaceStateRoot !== context.stateRoot) throw new Error("Native Git service workspace identity mismatch");
      return `http://${attachment.gateway}:${attachment.port}`;
    }
  },
  commands: [{ name: "project", description: "Register Native Projects and their independent reviewed repositories" }],
  async run(args) { const { runNativeGitCli } = await import("./cli/index.js"); await runNativeGitCli(args); },
  guest: {
    description: "Scoped Git read and proposal-write access for repositories selected by a managed Project workspace",
    commands: [
      { name: "git", description: "Fetch and push this workspace's scoped managed repositories through their configured origins" },
      { name: "dim-ci", description: "Request and inspect exact-candidate DIM CI for this repository using its scoped Git grant" },
    ],
    async inspect(workspace) {
      return workspace.source.url.startsWith("dim://")
        ? { state: "ready" }
        : { state: "unconfigured", message: "Create a managed dim:// Project workspace to use Native Git repository access" };
    }
  }
};
