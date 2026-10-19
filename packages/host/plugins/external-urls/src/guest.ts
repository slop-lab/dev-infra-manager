import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deployGuestIntegration, type WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";
import { UserError, workspacePluginRequest } from "@slop-lab/dim-managed";
import { readExternalUrlConfig } from "@slop-lab/dim-contracts-external-url";

/** The agent can request a named loopback service, but cannot choose an admin
 * socket, another workspace, nested container, arbitrary hostname or approval. */
export const hostPlugin: WorkspaceHostPlugin = {
  name: "external-urls",
  async workspaceReady(workspace, context) {
    await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
      name: "external-urls",
      files: [{ path: ".local/bin/dim-expose", contents: await readFile(new URL("./guest/dim-expose.mjs", import.meta.url)), mode: 0o700 }]
    });
  },
  guest: {
    description: "Request host-approved URLs for services on this workspace's loopback interface.",
    commands: [{ name: "dim-expose", description: "Expose a service or list this workspace's URL requests." }],
    async inspect() {
      const configured = Object.values((await readExternalUrlConfig()).ingresses).some((ingress) => ingress.scheme === "http" || ingress.scheme === "https");
      return configured ? { state: "ready" } : { state: "unconfigured", message: "Ask the host operator to configure an HTTP ingress." };
    },
    operations: [{
      name: "expose", description: "Request an approved ingress route to a workspace loopback service.",
      async handle(input, workspace, context) {
        if (!isRecord(input) || Object.keys(input).sort().join() !== "ingress,name,port"
          || typeof input.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.name)
          || typeof input.ingress !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.ingress)
          || typeof input.port !== "number" || !Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) {
          throw new UserError("expose requires a service name, ingress and loopback port");
        }
        const normalized = workspace.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "workspace";
        const identity = createHash("sha256").update(workspace.name).digest("hex").slice(0, 16);
        const prefix = normalized.slice(0, Math.max(1, 63 - input.name.length - 19));
        const subdomain = `${prefix}-${identity}--${input.name}`;
        return workspacePluginRequest(workspace, "/api/urls", {
          method: "POST", body: { ingress: input.ingress, subdomain, target: { containers: [], port: input.port, protocol: "http" } }
        }, context.signal);
      }
    }, {
      name: "urls", description: "List this workspace's URL requests and approval states.",
      async handle(input, workspace, context) {
        if (!isRecord(input) || Object.keys(input).length) throw new UserError("urls accepts no workspace selector or options");
        return workspacePluginRequest(workspace, "/api/urls", { method: "GET" }, context.signal);
      }
    }]
  }
};

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
