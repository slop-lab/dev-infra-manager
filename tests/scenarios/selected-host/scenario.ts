import { request } from "node:http";
import { request as requestHttps } from "node:https";
import { randomBytes } from "node:crypto";
import { ownedPartialWorkspace, ownedWorkspaceName, smokeWorkspaceName, OperatorInputError, SmokeFailure, type HostProfile, type OwnedWorkspace } from "./config.js";
import type { MonitorEvidence } from "./monitor.js";
import { authenticatedMonitorClient } from "./monitorClient.js";
import { monitorInspection } from "./monitorCommand.ts";
import { cleanupOwnedSmokeWorkspace } from "./cleanup.js";
import { guestLlmChannelProbe, parseLlmChannelEvidence, parseSshHostKey, parseWorkspaceDiscoveryEvidence } from "./runtimeEvidence.js";
import { verifyOrdinaryLifecycle, type OrdinaryRuntimeVersions } from "./ordinaryLifecycle.js";
import { expectSmokeApplication, startSmokeApplication } from "./applicationEndpoint.js";
import { verifyAuxiliaryVm } from "./auxiliaryVm.js";
import { inspectConfiguredMonitor } from "./monitorScenario.js";
import { dim, selectedCommandTracker, type CommandEvidence } from "./selectedCommand.js";

type PluginEntry = { readonly name: string; readonly state?: string; readonly commands: readonly string[] };
type PreflightResult = { readonly ok: boolean; readonly details: readonly string[] };
type SmokeOptions = { readonly onProgress?: (step: string, phase: "pass" | "progress" | "incomplete") => void; readonly onCommand?: (evidence: CommandEvidence) => void; readonly onRuntimeVersions?: (versions: OrdinaryRuntimeVersions) => void };
type EndpointEvidence = { readonly kind: "application" | "coding-agent"; readonly url: string; readonly disposition: "verified-then-discarded" };
export type SmokeResult = { readonly workspace: OwnedWorkspace; readonly runtimeVersions: OrdinaryRuntimeVersions; readonly monitor: MonitorEvidence | null; readonly commands: readonly CommandEvidence[]; readonly endpoints: readonly EndpointEvidence[]; readonly lanes: readonly { readonly name: string; readonly status: "PASS" | "BLOCKED"; readonly reason?: string }[] };

export async function preflightHost(profile: HostProfile, installedSourceSha: string): Promise<PreflightResult> {
  const details: string[] = [];
  const version = await dim(profile.name, ["--version"], true);
  const actualVersion = version.stdout.trim();
  details.push(actualVersion === profile.expectedHostVersion
    ? `host-version=${/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9._-]{1,180})?$/.test(actualVersion) ? actualVersion : "validated selection"}`
    : "host-version does not match the reviewed selected-host profile");

  const doctor = await dim(profile.name, ["doctor", "--json"], true);
  const checks = array(json(doctor.stdout, "doctor output"), "doctor output");
  let doctorReady = checks.length > 0;
  for (const value of checks) {
    const check = record(value, "doctor check");
    const name = text(check["name"], "doctor check name");
    const ok = check["ok"] === true;
    doctorReady &&= ok;
    const detail = text(check["detail"], "doctor check detail");
    details.push(`${ok ? "ok" : "unavailable"}: ${/^[a-zA-Z0-9 ._-]{1,80}$/.test(name) ? name : "host check"}`);
  }

  const plugins = parsePlugins((await dim(profile.name, ["plugins"], true)).stdout);
  for (const required of profile.requiredPlugins) {
    details.push(plugins.some(({ name }) => name === required) ? `plugin=${required}` : `missing-plugin=${required}`);
  }

  const listed = array(json((await dim(profile.name, ["list", "--json"], true)).stdout, "workspace list"), "workspace list");
  const workspaceAvailable = !listed.some((value) => record(value, "workspace")["name"] === profile.workspace);
  details.push(workspaceAvailable ? `workspace-name available=${profile.workspace}` : `workspace-name already exists=${profile.workspace}`);
  details.push(`operator-declared-source-sha=${installedSourceSha}`);
  const ready = version.exitCode === 0 && actualVersion === profile.expectedHostVersion
    && doctor.exitCode === 0 && doctorReady && profile.requiredPlugins.every((required) => plugins.some(({ name }) => name === required))
    && workspaceAvailable;
  return { ok: ready, details };
}

export async function runHostSmoke(selected: HostProfile, options: SmokeOptions = {}): Promise<SmokeResult> {
  const profile = { ...selected, workspace: smokeWorkspaceName(selected.workspace) };
  const { checked, commands } = selectedCommandTracker(options.onCommand);
  const endpoints: EndpointEvidence[] = [];
  let owned: OwnedWorkspace | undefined;
  let attemptedCreate = false, branchAttempted = false, candidateCommit: string | undefined;
  const startedAt = Date.now(), branch = `smoke/${randomBytes(16).toString("hex")}`;
  let monitorEvidence: MonitorEvidence | null = null;
  let runtimeVersions: OrdinaryRuntimeVersions;
  const lanes: Array<{ readonly name: string; readonly status: "PASS" | "BLOCKED"; readonly reason?: string }> = [];
  const progress = (step: string, phase: "pass" | "progress" | "incomplete" = "pass"): void => { options.onProgress?.(step, phase); };
  try {
    attemptedCreate = true;
    const created = await checked(profile, "workspace creation", [
      "create", profile.source, profile.workspace, "--ref", profile.workspaceSourceSha,
      "--git-user-name", "DIM selected-host smoke", "--git-user-email", "dim-smoke@example.invalid", "--json"
    ]);
    owned = ownedWorkspaceName(profile.workspace, json(created.stdout, "created workspace"));
    progress("workspace creation");
    runtimeVersions = await verifyOrdinaryLifecycle({ workspace: owned, run: (step, args, timeout) => checked(profile, step, args, timeout) });
    options.onRuntimeVersions?.(runtimeVersions);
    progress("ordinary identity, binary copy, resources, stop/start/idempotent-start/restart and retained data");
    lanes.push({ name: "ordinary-workspace-lifecycle-copy-resources", status: "PASS" });

    const sourceSha = (await checked(profile, "fresh source checkout", ["exec", owned.name, "--", "git", "rev-parse", "HEAD"])).stdout.trim();
    if (sourceSha !== profile.workspaceSourceSha) throw new SmokeFailure(profile.name, "candidate checkout", "checkout did not match the fresh workspace source SHA");
    progress(`fresh workspace source SHA ${profile.workspaceSourceSha}`);
    const discovery = parseWorkspaceDiscoveryEvidence((await checked(profile, "generic workspace discovery", ["exec", owned.name, "--", "dim-workspace", "discovery"])).stdout,
      { workspaceId: owned.id, workspaceName: owned.name, workspaceSourceSha: profile.workspaceSourceSha,
        requiredPlugins: profile.requiredPlugins });
    progress("authoritative generic discovery through the shared stdio workspace service");

    await checked(profile, "guest SSH setup", ["exec", owned.name, "--", "sh", "-c",
      "printf '%s\\n' \"$1\" | dim-workspace-ssh setup >/dev/null", "smoke", profile.sshPublicKey]);
    const sshHostKey = parseSshHostKey((await checked(profile, "guest SSH host key", ["exec", owned.name, "--", "dim-workspace-ssh", "host-key"])).stdout);
    progress("guest loopback SSH service configured with a persistent host key");

    const token = randomBytes(16).toString("hex");
    await checked(profile, "guest Git write", ["exec", owned.name, "--", "sh", "-c",
      "printf '%s\\n' \"$1\" > selected-host-input.txt && git add selected-host-input.txt && git commit -m 'selected-host smoke write' >/dev/null", "smoke", token]);
    if (profile.source.startsWith("dim://")) {
      const { CandidateCiError, verifyWorkspaceCandidateCi } = await import("./candidateCi.js");
      await checked(profile, "guest Git fetch", ["exec", owned.name, "--", "git", "fetch", "origin"]);
      candidateCommit = (await checked(profile, "guest commit identity", ["exec", owned.name, "--", "git", "rev-parse", "HEAD"])).stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(candidateCommit)) throw new SmokeFailure(profile.name, "guest commit identity", "invalid candidate commit");
      branchAttempted = true;
      await checked(profile, "guest ordinary-branch push", ["exec", owned.name, "--", "git", "push", "origin", `HEAD:refs/heads/${branch}`]);
      await checked(profile, "guest remote branch readback", ["exec", owned.name, "--", "git", "fetch", "origin", `refs/heads/${branch}`]);
      const fetchedCommit = (await checked(profile, "guest fetched identity", ["exec", owned.name, "--", "git", "rev-parse", "FETCH_HEAD"])).stdout.trim();
      if (candidateCommit !== fetchedCommit) throw new SmokeFailure(profile.name, "guest Git read/write", "remote readback did not match the exact pushed commit");
      progress("actual guest Git fetch, ordinary-branch push and exact readback");
      const available = parsePlugins((await checked(profile, "CI helper discovery", ["exec", owned.name, "--", "dim-workspace", "plugins"])).stdout);
      if (!available.some((plugin) => plugin.name === "native-git" && plugin.state === "ready" && plugin.commands.includes("dim-ci"))) throw new SmokeFailure(profile.name, "CI helper discovery", "the scoped candidate CI helper is not advertised");
      progress("scoped candidate CI helper discovered");
      try { await verifyWorkspaceCandidateCi({ workspace: owned.name, candidateRef: `refs/heads/${branch}`, candidateCommit,
        run: (step, args, timeout) => checked(profile, step, args, timeout), progress }); }
      catch (error) { if (error instanceof CandidateCiError) throw new SmokeFailure(profile.name, "workspace candidate CI", error.message); throw error; }
    }

    await checked(profile, "owned workspace LLM attachment", ["llm", "attach", owned.name, "--config", profile.llm.configFile, "--project", profile.llm.project, "--route", profile.llm.route]);
    await checked(profile, "owned workspace OpenCode setup", ["tools", "setup", owned.name, "opencode"], 10 * 60_000);

    const guestPlugins = parsePlugins((await checked(profile, "guest plugin discovery", ["exec", owned.name, "--", "dim-workspace", "plugins"])).stdout);
    for (const required of profile.requiredPlugins) {
      const plugin = guestPlugins.find(({ name }) => name === required);
      if (plugin === undefined) throw new SmokeFailure(profile.name, "guest plugin discovery", `${required} is not delivered`);
      const unattached = required === "kvm" || required === "vm" || required === "native-git" && !profile.source.startsWith("dim://");
      if (plugin.state !== (unattached ? "unconfigured" : "ready")) {
        throw new SmokeFailure(profile.name, "guest plugin discovery", "a required guest plugin is not ready for the owned workspace");
      }
    }
    progress("guest plugin discovery");

    parseLlmChannelEvidence((await checked(profile, "shared service channel HTTP", ["exec", owned.name, "--", "node", "-e", guestLlmChannelProbe], 60_000)).stdout);
    progress("actual guest HTTP request through the shared stdio service channel");

    const prompt = `Use your file tools to read selected-host-input.txt. Create selected-host-llm.txt containing exactly the same token and no other text. Do not answer until the file is written.`;
    await checked(profile, "actual LLM and tool execution", ["tools", "run", owned.name, "opencode", "run", prompt], 10 * 60_000);
    const llmToken = (await checked(profile, "LLM tool result", ["exec", owned.name, "--", "cat", "selected-host-llm.txt"])).stdout.trim();
    if (llmToken !== token) throw new SmokeFailure(profile.name, "LLM tool result", "the model did not reproduce the private challenge through a file tool");
    progress("actual LLM and file-tool execution");
    lanes.push({ name: "scoped-real-llm-model-and-tool", status: "PASS" });
    const connectionFingerprint = ["exec", owned.name, "--", "node", "-e", 'const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");const value=JSON.parse(fs.readFileSync(path.join(process.env.HOME,".config/dim/llm-router.json"),"utf8"));process.stdout.write(crypto.createHash("sha256").update(JSON.stringify([value.workspaceId,value.projectId,value.principalId,value.token])).digest("hex"))'];
    const beforeBinding = (await checked(profile, "durable LLM binding fingerprint", connectionFingerprint)).stdout;
    await checked(profile, "attached workspace interruption", ["restart", owned.name, "--expect-id", owned.id, "--json"], 180_000);
    if ((await checked(profile, "recovered LLM binding fingerprint", connectionFingerprint)).stdout !== beforeBinding) throw new SmokeFailure(profile.name, "LLM recovery", "workspace restart rotated the retained LLM identity");
    parseLlmChannelEvidence((await checked(profile, "recovered scoped LLM channel", ["exec", owned.name, "--", "node", "-e", guestLlmChannelProbe], 60_000)).stdout);
    lanes.push({ name: "scoped-llm-restart-recovery", status: "PASS" });
    const applicationUrl = await startSmokeApplication({ workspace: owned, ingress: profile.ingress, challenge: token,
      run: (step, args) => checked(profile, step, args) });
    progress("distinct application endpoint: real shared-ingress schema and challenge response");
    endpoints.push({ kind: "application", url: applicationUrl, disposition: "verified-then-discarded" });
    lanes.push({ name: "application-endpoint", status: "PASS" });

    await checked(profile, "OpenCode server start", ["tools", "server", owned.name], 180_000);
    const server = record(json((await checked(profile, "OpenCode server status", ["tools", "server", owned.name, "status", "--json"])).stdout, "server status"), "server status");
    if (server["state"] !== "running") throw new SmokeFailure(profile.name, "OpenCode server status", "owned server is not running");
    progress("owned OpenCode server");

    const exposure = record(json((await checked(profile, "shared ingress request", ["exec", owned.name, "--", "dim-expose", "--name", "opencode", "--port", "4096", "--ingress", profile.ingress])).stdout, "exposure"), "exposure");
    const url = text(exposure["url"], "exposure URL");
    await expectAuthenticationBoundary(url);
    progress("shared ingress credential boundary");
    const credentialOutput = await checked(profile, "OpenCode public capability credentials", ["tools", "console", "invoke", "server.credentials", "--input", JSON.stringify({ workspace: owned.name, workspaceId: owned.id }), "--json"]);
    const credentials = record(json(credentialOutput.stdout, "server credentials"), "server credentials");
    const client = authenticatedMonitorClient(url, { username: text(credentials["username"], "server username"), password: text(credentials["password"], "server password") }, "/workspace");
    const sessionIds = array(await client.get("/session", 30_000), "authenticated OpenCode sessions").map((session) => text(record(session, "OpenCode session")["id"], "session id"));
    if (sessionIds.length === 0) throw new SmokeFailure(profile.name, "OpenCode session", "real model/tool run produced no authenticated session");
    progress("authenticated OpenCode session through shared ingress");
    endpoints.push({ kind: "coding-agent", url, disposition: "verified-then-discarded" });
    lanes.push({ name: "opencode-authenticated-session-ingress", status: "PASS" });
    if (profile.vm !== undefined) {
      await verifyAuxiliaryVm({ workspace: owned, image: profile.vm.image, challenge: token,
        run: (step, args, timeout) => checked(profile, step, args, timeout),
        rejected: async (step, args) => { const result = await dim(profile.name, args, true); if (result.exitCode === 0) throw new SmokeFailure(profile.name, step, "revoked operation unexpectedly succeeded"); } });
      lanes.push({ name: "auxiliary-kvm-vm", status: "PASS" });
    } else lanes.push({ name: "auxiliary-kvm-vm", status: "BLOCKED", reason: "Profile requires vm plugin, reviewed Incus host/image and explicit operator provisioning authority" });

    if (profile.monitor !== undefined) {
      progress("OpenCode monitor: reading bounded public session metadata", "progress");
      monitorEvidence = await inspectConfiguredMonitor({ profile: profile.monitor, workspace: owned.name, endpoint: url,
        credentials: { username: text(credentials["username"], "server username"), password: text(credentials["password"], "server password") },
        run: (step, args, timeout) => checked(profile, step, args, timeout) });
      progress(`OpenCode monitor: ${monitorEvidence.state}; discovery=${monitorEvidence.discovery}; completion=${monitorEvidence.completion}`, monitorInspection(monitorEvidence) === "inspected" ? "pass" : "incomplete");
    }

    const recreated = ownedWorkspaceName(profile.workspace, json((await checked(profile, "workspace recreate", ["recreate", owned.name, "--expect-id", owned.id, "--json"], 180_000)).stdout, "recreated workspace"));
    if (recreated.id !== owned.id) throw new SmokeFailure(profile.name, "workspace recreate", "immutable workspace identity changed");
    const retained = (await checked(profile, "recreated Git state", ["exec", owned.name, "--", "cat", "selected-host-llm.txt"])).stdout.trim();
    if (retained !== token) throw new SmokeFailure(profile.name, "recreated Git state", "guest data was not retained");
    const rediscovered = parsePlugins((await checked(profile, "recreated helper discovery", ["exec", owned.name, "--", "dim-workspace", "plugins"])).stdout);
    if (profile.source.startsWith("dim://") && !rediscovered.some((plugin) => plugin.name === "native-git" && plugin.state === "ready" && plugin.commands.includes("dim-ci"))) throw new SmokeFailure(profile.name, "recreated helper discovery", "native Git helper did not reconnect after recreation");
    parseLlmChannelEvidence((await checked(profile, "recreated shared service channel HTTP", ["exec", owned.name, "--", "node", "-e", guestLlmChannelProbe], 60_000)).stdout);
    const recreatedSshHostKey = parseSshHostKey((await checked(profile, "recreated SSH host key", ["exec", owned.name, "--", "dim-workspace-ssh", "host-key"])).stdout);
    if (recreatedSshHostKey !== sshHostKey) throw new SmokeFailure(profile.name, "recreated SSH host key", "persistent SSH host identity changed");
    const recreatedDiscovery = parseWorkspaceDiscoveryEvidence((await checked(profile, "recreated generic workspace discovery", ["exec", owned.name, "--", "dim-workspace", "discovery"])).stdout,
      { workspaceId: owned.id, workspaceName: owned.name, workspaceSourceSha: profile.workspaceSourceSha,
        requiredPlugins: profile.requiredPlugins });
    if (recreatedDiscovery.generation !== discovery.generation) throw new SmokeFailure(profile.name, "recreated generic workspace discovery", "workspace bridge generation changed without an installed source change");
    await waitForAuthenticationBoundary(url);
    await expectSmokeApplication(applicationUrl, token);
    const recoveredSessions = array(await client.get("/session", 30_000), "recovered authenticated sessions").map((session) => text(record(session, "OpenCode session")["id"], "session id"));
    if (!sessionIds.every((id) => recoveredSessions.includes(id))) throw new SmokeFailure(profile.name, "OpenCode recovery", "authentication or saved sessions did not survive recreation");
    progress("recreate, reconnect, helper rediscovery, shared-channel HTTP, SSH identity and retained data");
    lanes.push({ name: "recreation-and-service-reconnection", status: "PASS" });
  } finally {
    if (owned === undefined && attemptedCreate) {
      const partial = await dim(profile.name, ["show", profile.workspace, "--json"], true);
      if (partial.exitCode === 0) {
        owned = ownedPartialWorkspace({ name: profile.workspace, source: profile.source, startedAt }, json(partial.stdout, "partial workspace"));
      } else progress("partial creation: no owned UUID was discoverable; no unproven resource was discarded");
    }
    if (owned !== undefined) {
      if (branchAttempted && candidateCommit === undefined) throw new SmokeFailure(profile.name, "owned cleanup", "branch commit ownership is unavailable; workspace retained for operator inspection");
      await cleanupOwnedSmokeWorkspace({ host: profile.name, owned,
        ...(branchAttempted && candidateCommit !== undefined ? { branch: { ref: `refs/heads/${branch}`, commit: candidateCommit } } : {}),
        run: (args, timeoutMs) => dim(profile.name, args, true, timeoutMs) });
      progress("exact owned cleanup");
    }
  }
  return { workspace: owned, runtimeVersions, monitor: monitorEvidence, lanes, commands, endpoints };
}

function parsePlugins(output: string): readonly PluginEntry[] {
  const parsed = json(output, "plugin discovery");
  const entries = Array.isArray(parsed) ? parsed : record(parsed, "guest plugin discovery")["plugins"];
  return array(entries, "plugin discovery").map((value) => {
    const plugin = record(value, "plugin");
    const state = plugin["state"];
    if (state !== undefined && typeof state !== "string") throw new OperatorInputError("plugin state must be a string");
    const commands = plugin["commands"] === undefined ? [] : array(plugin["commands"], "plugin commands").map((entry) => text(record(entry, "plugin command")["name"], "plugin command name"));
    return { name: text(plugin["name"], "plugin name"), commands, ...(state === undefined ? {} : { state }) };
  });
}

async function expectAuthenticationBoundary(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  const client = url.protocol === "https:" ? requestHttps : url.protocol === "http:" ? request : undefined;
  if (client === undefined || url.username || url.password || url.search || url.hash) throw new OperatorInputError("shared ingress must return a credential-free HTTP(S) URL");
  const status = await new Promise<number>((resolve, reject) => {
    const call = client(url, { method: "GET", signal: AbortSignal.timeout(30_000) }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    call.once("error", reject); call.end();
  });
  if (status !== 401) throw new OperatorInputError(`shared ingress must reach the credential boundary (expected HTTP 401, received ${status})`);
}

async function waitForAuthenticationBoundary(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await expectAuthenticationBoundary(url); return; }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new OperatorInputError("shared ingress did not reconnect to the recreated owned server", { cause: last });
}

function json(output: string, label: string): unknown {
  try { return JSON.parse(output); }
  catch (error) { throw new OperatorInputError(`${label} is not JSON`, { cause: error }); }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperatorInputError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new OperatorInputError(`${label} must be an array`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OperatorInputError(`${label} must be a non-empty string`);
  return value;
}
