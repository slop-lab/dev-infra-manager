import type { HostProfile, OwnedWorkspace } from "../config.js";
import type { CommandResult } from "../../web-lifecycle/process.js";
import { fixtureModel } from "./provider.js";

export async function configureCiConsumer(input: { readonly workspace: OwnedWorkspace; readonly profile: HostProfile;
  readonly run: (step: string, args: readonly string[]) => Promise<CommandResult> }): Promise<void> {
  if (input.profile.llm.provider !== "dim-chat" || input.profile.llm.model !== fixtureModel) throw new Error("deterministic CI must use its explicit routed test model");
  const model = `${input.profile.llm.provider}/${input.profile.llm.model}`;
  const configuration = { model, small_model: model, default_agent: "practical-ci", enabled_providers: ["dim-chat"],
    agent: { "practical-ci": { model, mode: "primary", description: "Test-owned deterministic protocol/tool consumer, not external provider qualification" } },
    permission: { external_directory: "deny", bash: "deny", read: "allow", edit: "allow" } };
  await input.run("test-owned OpenCode model and primary-agent configuration", ["exec", input.workspace.name, "--", "node", "-e",
    'const fs=require("node:fs");fs.writeFileSync("opencode.json",process.argv[1],{mode:0o600,flag:"wx"});', JSON.stringify(configuration)]);
}
