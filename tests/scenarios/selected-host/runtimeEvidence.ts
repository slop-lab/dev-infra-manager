import { OperatorInputError } from "./config.js";

export const guestLlmChannelProbe = `const fs=require("node:fs"),os=require("node:os"),path=require("node:path");(async()=>{const endpoint="http://127.0.0.1:19420/services/llm-router";const connection=JSON.parse(fs.readFileSync(path.join(os.homedir(),".config/dim/llm-router.json"),"utf8"));if(connection.endpoint!==endpoint||typeof connection.token!=="string")throw Error("invalid shared channel connection");const response=await fetch(endpoint+"/v1/models",{redirect:"error",signal:AbortSignal.timeout(30000),headers:{authorization:"Bearer "+connection.token}});const body=await response.json();const modelCount=Array.isArray(body.data)?body.data.length:-1;process.stdout.write(JSON.stringify({schemaVersion:1,endpoint,status:response.status,modelCount}));})().catch(()=>process.exit(2));`;

type LlmChannelEvidence = { readonly endpoint: string; readonly status: 200; readonly modelCount: number };
type DiscoveryExpectation = { readonly workspaceId: string; readonly workspaceName: string; readonly workspaceSourceSha: string;
  readonly requiredPlugins: readonly string[] };

export function parseLlmChannelEvidence(output: string): LlmChannelEvidence {
  const evidence = object(parseJson(output, "LLM shared-channel evidence"), "LLM shared-channel evidence");
  if (evidence["schemaVersion"] !== 1 || evidence["endpoint"] !== "http://127.0.0.1:19420/services/llm-router") {
    throw new OperatorInputError("LLM probe did not use the guest shared service channel");
  }
  if (evidence["status"] !== 200) throw new OperatorInputError("LLM shared service channel did not return HTTP 200");
  const modelCount = evidence["modelCount"];
  if (!Number.isInteger(modelCount) || typeof modelCount !== "number" || modelCount < 1) throw new OperatorInputError("LLM shared service channel returned no routed models");
  return { endpoint: "http://127.0.0.1:19420/services/llm-router", status: 200, modelCount };
}

export function parseSshHostKey(output: string): string {
  const value = output.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,200})?$/.test(value)) throw new OperatorInputError("guest SSH host key is invalid");
  return value;
}

export function parseWorkspaceDiscoveryEvidence(output: string, expected: DiscoveryExpectation): { readonly generation: string } {
  const discovery = object(parseJson(output, "workspace discovery"), "workspace discovery");
  const workspace = object(discovery["workspace"], "workspace discovery identity");
  const source = object(workspace["source"], "workspace discovery source");
  if (discovery["schemaVersion"] !== 1 || workspace["id"] !== expected.workspaceId
    || workspace["name"] !== expected.workspaceName || workspace["runtime"] !== "container"
    || workspace["phase"] !== "running" || source["commit"] !== expected.workspaceSourceSha) {
    throw new OperatorInputError("workspace discovery identity or fresh source does not match this ordinary smoke workspace");
  }
  const freshness = object(discovery["freshness"], "workspace discovery freshness");
  const generation = freshness["bridgeGeneration"];
  if (typeof generation !== "string" || !/^[0-9a-f]{64}$/.test(generation)) throw new OperatorInputError("workspace discovery bridge generation is invalid");
  const pluginSet = array(discovery["pluginSet"], "workspace discovery plugin set");
  if (!pluginSet.every((plugin) => typeof plugin === "string")) throw new OperatorInputError("workspace discovery plugin set is invalid");
  for (const required of expected.requiredPlugins) {
    if (!pluginSet.includes(required)) throw new OperatorInputError(`workspace discovery omitted required plugin ${required}`);
  }
  const services = array(discovery["services"], "workspace discovery services").map((value) => object(value, "workspace discovery service"));
  const requiredServices = [["core", "workspace"],
    ...(expected.requiredPlugins.includes("native-git") ? [["native-git", "native-git"]] : []),
    ...(expected.requiredPlugins.includes("host-llm-router") ? [["host-llm-router", "llm-router"]] : [])] as const;
  for (const [owner, name] of requiredServices) {
    if (!services.some((service) => service["owner"] === owner && service["name"] === name)) throw new OperatorInputError(`workspace discovery omitted ${owner}/${name} shared service`);
  }
  const capabilities = array(discovery["capabilities"], "workspace discovery capabilities").map((value) => object(value, "workspace discovery capability"));
  if (pluginSet.includes("kvm")) {
    for (const name of ["direct-access", "vm-fd-verification"] as const) {
      const capability = capabilities.find((entry) => entry["owner"] === "kvm" && entry["name"] === name);
      const access = capability === undefined ? undefined : object(capability["access"], "KVM capability access");
      const reason = capability === undefined ? undefined : object(capability["reason"], "KVM capability reason");
      if (capability?.["state"] !== "blocked" || access?.["kind"] !== "none" || reason?.["code"] !== "runtime-grant-required") {
        throw new OperatorInputError("ordinary workspace KVM discovery must require a separate container-kvm workspace");
      }
    }
  }
  return { generation };
}

function parseJson(output: string, label: string): unknown {
  try { return JSON.parse(output); }
  catch (error) { throw new OperatorInputError(`${label} is not JSON`, { cause: error }); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperatorInputError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new OperatorInputError(`${label} must be an array`);
  return value;
}
