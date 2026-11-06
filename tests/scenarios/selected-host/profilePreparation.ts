import { createHash } from "node:crypto";
import { localArtifacts } from "../../../scripts/local-source-runtime.ts";
import { OperatorInputError, parseSmokeConfiguration, type SmokeConfiguration } from "./config.ts";

export function prepareSmokeProfile(input: { readonly bindings: unknown; readonly artifacts: unknown; readonly sourceSha: string; readonly sshPublicKey: string }): SmokeConfiguration & { readonly schemaVersion: 1 } {
  const bindings = object(input.bindings);
  if (bindings.schemaVersion !== 1 || Object.keys(bindings).some((key) => !["schemaVersion", "hosts", "isolatedUpdate"].includes(key)) || !Array.isArray(bindings.hosts)) throw new OperatorInputError("bindings require schemaVersion 1 and explicit hosts");
  const core = localArtifacts(input.artifacts, ["@slop-lab/dim-host-core"]).find(({ name }) => name === "@slop-lab/dim-host-core");
  if (!core) throw new OperatorInputError("reviewed bundle contains no host core");
  const hosts = bindings.hosts.map((value: unknown) => {
    const host = object(value);
    if (Object.keys(host).some((key) => !["name", "source", "workspaceSourceSha", "ingress", "llm", "vm", "monitor"].includes(key)) || typeof host.name !== "string") throw new OperatorInputError("bindings contain unknown or derived host fields");
    const suffix = createHash("sha256").update(host.name).digest("hex").slice(0, 8);
    return { ...host, workspace: `dim-smoke-${host.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 18)}-${suffix}`,
      workspaceSourceSha: host.workspaceSourceSha ?? input.sourceSha, expectedHostVersion: core.version, sshPublicKey: input.sshPublicKey,
      requiredPlugins: ["agent-tools", "host-llm-router", "external-urls", ...(host.vm === undefined ? [] : ["vm"])] };
  });
  return { schemaVersion: 1, ...parseSmokeConfiguration({ schemaVersion: 1, installedSourceSha: input.sourceSha, hosts,
    ...(bindings.isolatedUpdate === undefined ? {} : { isolatedUpdate: bindings.isolatedUpdate }) }) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperatorInputError("bindings must contain objects");
  return Object.fromEntries(Object.entries(value));
}
