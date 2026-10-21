import { createLlmRouterClient, llmOperation, llmOperations, privateOperatorFile } from "@slop-lab/dim-llm-router-client";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
const help = `dim llm-router OPERATION --connection /absolute/operator.json [options]
  capabilities | overview | accounts | health | projects | principals
  account.create [--account ID --reference NAME] --provider codex|openai|anthropic [--endpoint URL --api-key-file PRIVATE_FILE]
  account.rename --account ID --reference NAME
  account.models --account ID
  account.login.start --account ID
  account.login.status --account ID --session UUID
  route.upsert --route ID --account ID (--models all | --models-file PRIVATE_JSON)
  project.create --project ID --route ID
  project.policy --project ID
  project.policy.update --project ID --policy-file /absolute/policy.json
  project.state --project ID --action pause|resume|enable|disable
  usage --project ID
  principal.revoke --principal ID
  requests [--project ID] [--active true|false] [--limit 1..200]
  request.cancel --request UUID
  request.resolve --request UUID [--input-tokens N --output-tokens N]
Credentials and policy files must be owned mode-0600 files. Results are JSON.`;
export async function runLlmRouterCommand(args: readonly string[], signal?: AbortSignal): Promise<void> {
  if (args.length === 1 || args.includes("--help") || args.includes("-h")) { console.log(help); return; }
  const name = args[1]; if (!name) throw new Error(help);
  const operation = llmOperation(name), flags = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) { const key = args[index], value = args[index + 1]; if (!key?.startsWith("--") || !value || flags.has(key)) throw new Error(help); flags.set(key, value); }
  const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`required ${key}\n${help}`); return value; };
  const input: Record<string, unknown> = {}, allowed = new Set(["--connection"]);
  const take = (flag: string, field: string) => { allowed.add(flag); if (flags.has(flag)) input[field] = required(flag); };
  if (["project.create", "project.policy", "project.policy.update", "project.state", "usage", "requests"].includes(name)) take("--project", "projectId");
  if (name.startsWith("account.") || name === "route.upsert") take("--account", "accountId");
  if (name === "account.create") {
    take("--reference", "reference"); take("--provider", "provider"); take("--endpoint", "endpoint"); allowed.add("--api-key-file");
    if (flags.has("--api-key-file")) input.apiKey = (await privateOperatorFile(required("--api-key-file"))).trim();
  }
  if (name === "account.rename") take("--reference", "reference");
  if (name === "account.login.status") take("--session", "sessionId");
  if (name === "route.upsert") {
    take("--route", "routeId"); allowed.add("--models"); allowed.add("--models-file");
    if (flags.has("--models") === flags.has("--models-file")) throw new Error("select --models all or --models-file PRIVATE_JSON");
    if (flags.has("--models")) {
      if (required("--models") !== "all") throw new Error("--models requires all; use --models-file for a restricted list");
      input.models = "all";
    } else input.models = JSON.parse(await privateOperatorFile(required("--models-file"))) as unknown;
  }
  if (name === "project.create") take("--route", "routeId");
  if (name === "project.state") take("--action", "action");
  if (name === "project.policy.update") { allowed.add("--policy-file"); input.policy = JSON.parse(await privateOperatorFile(required("--policy-file"))) as unknown; }
  if (name === "principal.revoke") take("--principal", "principalId");
  if (name.startsWith("request.")) take("--request", "requestId");
  if (name === "requests") {
    allowed.add("--active"); allowed.add("--limit");
    if (flags.has("--active")) { if (!["true", "false"].includes(required("--active"))) throw new Error("--active requires true or false"); input.active = required("--active") === "true"; }
    if (flags.has("--limit")) input.limit = Number(required("--limit"));
  }
  if (name === "request.resolve") { allowed.add("--input-tokens"); allowed.add("--output-tokens"); if (flags.has("--input-tokens") || flags.has("--output-tokens")) input.usage = { inputTokens: Number(required("--input-tokens")), outputTokens: Number(required("--output-tokens")) }; }
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`unsupported option ${flag}\n${help}`);
  if (name === "project.policy.update") { const project = await createLlmRouterClient(required("--connection"), signal === undefined ? {} : { signal }).invoke("project.policy", { projectId: input.projectId }); if (typeof project !== "object" || project === null || !("revision" in project)) throw new Error("router returned no policy revision"); input.expectedRevision = project.revision; }
  const parsed = operation.parseInput(input);
  console.log(JSON.stringify(await createLlmRouterClient(required("--connection"), signal === undefined ? {} : { signal }).invoke(name, parsed), null, 2));
}
export const hostPlugin: WorkspaceHostPlugin = { name: "llm-router-operator", commands: [{ name: "llm-router", description: "Inspect and manage an LLM router through a private operator connection" }], async run(args, context) { await runLlmRouterCommand(args, context.signal); } };
export { llmOperations };
