import { request } from "node:http";
import { request as requestHttps } from "node:https";
import { randomBytes } from "node:crypto";
import type { HostProfile } from "./config.js";
import { ownedPartialWorkspace, ownedWorkspaceName, smokeWorkspaceName, OperatorInputError, SmokeFailure, type OwnedWorkspace } from "./config.js";
import { runCommand, type CommandResult } from "../web-lifecycle/process.js";
import { inspectOpenCodeMonitor, parseOmoTeamMetadata, type MonitorEvidence, type OmoTeamMetadata } from "./monitor.js";
import { authenticatedMonitorClient } from "./monitorClient.js";
import { monitorInspection } from "./monitorCommand.ts";
import { cleanupOwnedSmokeWorkspace } from "./cleanup.js";
import { CandidateCiError, verifyWorkspaceCandidateCi } from "./candidateCi.js";

type PluginEntry = { readonly name: string; readonly state?: string; readonly commands: readonly string[] };
type PreflightResult = { readonly ok: boolean; readonly details: readonly string[] };
type SmokeOptions = { readonly onProgress?: (step: string, phase: "pass" | "progress" | "incomplete") => void };

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

export async function runHostSmoke(selected: HostProfile, installedSourceSha: string, options: SmokeOptions = {}): Promise<MonitorEvidence | null> {
  const profile = { ...selected, workspace: smokeWorkspaceName(selected.workspace) };
  let owned: OwnedWorkspace | undefined;
  let attemptedCreate = false, branchAttempted = false, candidateCommit: string | undefined;
  const startedAt = Date.now(), branch = `smoke/${randomBytes(16).toString("hex")}`;
  let monitorEvidence: MonitorEvidence | null = null;
  const progress = (step: string, phase: "pass" | "progress" | "incomplete" = "pass"): void => { options.onProgress?.(step, phase); };
  try {
    attemptedCreate = true;
    const created = await checked(profile, "workspace creation", [
      "create", profile.source, profile.workspace, "--ref", installedSourceSha,
      "--git-user-name", "DIM selected-host smoke", "--git-user-email", "dim-smoke@example.invalid", "--json"
    ]);
    owned = ownedWorkspaceName(profile.workspace, json(created.stdout, "created workspace"));
    progress("workspace creation");

    const sourceSha = (await checked(profile, "installed source checkout", ["exec", owned.name, "--", "git", "rev-parse", "HEAD"])).stdout.trim();
    if (sourceSha !== installedSourceSha) throw new SmokeFailure(profile.name, "candidate checkout", "checkout did not match the operator-declared candidate SHA");
    progress(`candidate checkout SHA ${installedSourceSha}`);

    const token = randomBytes(16).toString("hex");
    await checked(profile, "guest Git write", ["exec", owned.name, "--", "sh", "-c",
      "printf '%s\\n' \"$1\" > selected-host-input.txt && git add selected-host-input.txt && git commit -m 'selected-host smoke write' >/dev/null", "smoke", token]);
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

    await checked(profile, "owned workspace LLM attachment", ["llm", "attach", owned.name, "--config", profile.llm.configFile, "--project", profile.llm.project, "--route", profile.llm.route]);
    await checked(profile, "owned workspace OpenCode setup", ["tools", "setup", owned.name, "opencode"], 10 * 60_000);

    const guestPlugins = parsePlugins((await checked(profile, "guest plugin discovery", ["exec", owned.name, "--", "dim-workspace", "plugins"])).stdout);
    for (const required of profile.requiredPlugins) {
      const plugin = guestPlugins.find(({ name }) => name === required);
      if (plugin === undefined) throw new SmokeFailure(profile.name, "guest plugin discovery", `${required} is not delivered`);
      if (plugin.state !== "ready") {
        throw new SmokeFailure(profile.name, "guest plugin discovery", "a required guest plugin is not ready for the owned workspace");
      }
    }
    progress("guest plugin discovery");

    const prompt = `Use your file tools to read selected-host-input.txt. Create selected-host-llm.txt containing exactly the same token and no other text. Do not answer until the file is written.`;
    await checked(profile, "actual LLM and tool execution", ["tools", "run", owned.name, "opencode", "run", prompt], 10 * 60_000);
    const llmToken = (await checked(profile, "LLM tool result", ["exec", owned.name, "--", "cat", "selected-host-llm.txt"])).stdout.trim();
    if (llmToken !== token) throw new SmokeFailure(profile.name, "LLM tool result", "the model did not reproduce the private challenge through a file tool");
    progress("actual LLM and file-tool execution");

    await checked(profile, "OpenCode server start", ["tools", "server", owned.name], 180_000);
    const server = record(json((await checked(profile, "OpenCode server status", ["tools", "server", owned.name, "status", "--json"])).stdout, "server status"), "server status");
    if (server["state"] !== "running") throw new SmokeFailure(profile.name, "OpenCode server status", "owned server is not running");
    progress("owned OpenCode server");

    const exposure = record(json((await checked(profile, "shared ingress request", ["exec", owned.name, "--", "dim-expose", "--name", "opencode", "--port", "4096", "--ingress", profile.ingress])).stdout, "exposure"), "exposure");
    const url = text(exposure["url"], "exposure URL");
    await expectAuthenticationBoundary(url);
    progress("shared ingress credential boundary");

    if (profile.monitor !== undefined) {
      const monitorDeadline = Date.now() + profile.monitor.deadlineSeconds * 1000;
      progress("OpenCode monitor: reading bounded public session metadata", "progress");
      const credentialOutput = await checked(profile, "OpenCode monitor credentials", ["tools", "console", "invoke", "server.credentials", "--input", JSON.stringify({ workspace: owned.name, workspaceId: owned.id }), "--json"], Math.max(1, monitorDeadline - Date.now()));
      const credentials = record(json(credentialOutput.stdout, "server credentials"), "server credentials");
      const username = text(credentials["username"], "server credential username");
      const password = text(credentials["password"], "server credential password");
      let team: OmoTeamMetadata = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: false };
      if (profile.monitor.omoMetadataPath !== undefined) {
        const rawTeam = await checked(profile, "optional OMO metadata adapter", ["exec", owned.name, "--", "cat", profile.monitor.omoMetadataPath], Math.max(1, monitorDeadline - Date.now()));
        team = parseOmoTeamMetadata(json(rawTeam.stdout, "OMO metadata"), profile.monitor.maxSessions, profile.monitor.maxSessions);
      }
      monitorEvidence = await inspectOpenCodeMonitor({
        parentSessionId: profile.monitor.parentSessionId, directory: profile.monitor.directory,
        maxSessions: profile.monitor.maxSessions, maxDepth: profile.monitor.maxDepth, maxRequests: profile.monitor.maxRequests,
        recentMessages: profile.monitor.recentMessages, staleMinutes: profile.monitor.staleMinutes,
        deadlineMs: Math.max(1, monitorDeadline - Date.now()), requestTimeoutMs: profile.monitor.requestTimeoutSeconds * 1_000
      }, team, authenticatedMonitorClient(url, { username, password }, profile.monitor.directory));
      progress(`OpenCode monitor: ${monitorEvidence.state}; discovery=${monitorEvidence.discovery}; completion=${monitorEvidence.completion}`, monitorInspection(monitorEvidence) === "inspected" ? "pass" : "incomplete");
    }

    const recreated = ownedWorkspaceName(profile.workspace, json((await checked(profile, "workspace recreate", ["recreate", owned.name, "--expect-id", owned.id, "--json"], 180_000)).stdout, "recreated workspace"));
    if (recreated.id !== owned.id) throw new SmokeFailure(profile.name, "workspace recreate", "immutable workspace identity changed");
    const retained = (await checked(profile, "recreated Git state", ["exec", owned.name, "--", "cat", "selected-host-llm.txt"])).stdout.trim();
    if (retained !== token) throw new SmokeFailure(profile.name, "recreated Git state", "guest data was not retained");
    await waitForAuthenticationBoundary(url);
    progress("recreate, reconnect and retained data");
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
  return monitorEvidence;
}

async function checked(profile: HostProfile, step: string, args: readonly string[], timeoutMs = 120_000): Promise<CommandResult> {
  let result: CommandResult;
  try { result = await dim(profile.name, args, true, timeoutMs); }
  catch { throw new SmokeFailure(profile.name, step, "selected-host transport, output bound or deadline failed; inspect private host diagnostics"); }
  if (result.exitCode !== 0) throw new SmokeFailure(profile.name, step, `command exited ${result.exitCode}; inspect this selected host interactively`);
  return result;
}

function dim(host: string, args: readonly string[], acceptFailure: boolean, timeoutMs = 120_000): Promise<CommandResult> {
  return runCommand("dim", ["--host", host, ...args], { acceptFailure, timeoutMs });
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
  if (client === undefined) throw new OperatorInputError("shared ingress returned a non-HTTP URL");
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
