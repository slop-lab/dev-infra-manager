import { request } from "node:http";
import { request as requestHttps } from "node:https";
import { randomBytes } from "node:crypto";
import { ownedPartialWorkspace, ownedWorkspaceName, smokeWorkspaceName, ownedMonitorDefaults, OperatorInputError, SmokeFailure, type HostProfile, type OwnedWorkspace } from "./config.js";
import type { MonitorEvidence } from "./monitor.js";
import { authenticatedMonitorClient } from "./monitorClient.js";
import { monitorInspection } from "./monitorCommand.ts";
import { cleanupOwnedSmokeWorkspace } from "./cleanup.js";
import { guestLlmChannelProbe, parseLlmChannelEvidence, parseSshHostKey, parseWorkspaceDiscoveryEvidence } from "./runtimeEvidence.js";
import { verifyOrdinaryLifecycle, type OrdinaryRuntimeVersions } from "./ordinaryLifecycle.js";
import { expectSmokeApplication, startSmokeApplication } from "./applicationEndpoint.js";
import { verifyAuxiliaryVm } from "./auxiliaryVm.js";
import { inspectConfiguredMonitor } from "./monitorScenario.js";
import { dim, selectedCommandTracker, type CommandEvidence, type FixtureFailureWriter } from "./selectedCommand.js";
import { selectExposureUrl } from "./exposure.js";
import { array, json, parsePlugins, record, text } from "./scenarioValues.js";
import { executeOwnedInference, verifyOwnedSessionModel } from "./ownedInference.js";
import { configureCiConsumer } from "./ci/consumer.js";
export { preflightHost } from "./preflight.js";

type SmokeOptions = { readonly writeFixtureFailure?: FixtureFailureWriter; readonly onProgress?: (step: string, phase: "pass" | "progress" | "incomplete") => void; readonly onCommand?: (evidence: CommandEvidence) => void; readonly onRuntimeVersions?: (versions: OrdinaryRuntimeVersions) => void };
type EndpointEvidence = { readonly kind: "application" | "coding-agent"; readonly url: string; readonly disposition: "verified-then-discarded" };
export type SmokeResult = { readonly workspace: OwnedWorkspace; readonly runtimeVersions: OrdinaryRuntimeVersions; readonly auxiliaryVm: Awaited<ReturnType<typeof verifyAuxiliaryVm>> | null; readonly inference: Awaited<ReturnType<typeof executeOwnedInference>>; readonly sessionModel: Awaited<ReturnType<typeof verifyOwnedSessionModel>>; readonly monitor: MonitorEvidence | null; readonly commands: readonly CommandEvidence[]; readonly endpoints: readonly EndpointEvidence[]; readonly lanes: readonly { readonly name: string; readonly status: "PASS" | "BLOCKED"; readonly reason?: string }[] };

export async function runHostSmoke(selected: HostProfile, options: SmokeOptions = {}): Promise<SmokeResult> {
  const profile = { ...selected, workspace: smokeWorkspaceName(selected.workspace) };
  const { checked, commands } = selectedCommandTracker(options.onCommand, options.writeFixtureFailure, step => options.onProgress?.(step, "progress"));
  const endpoints: EndpointEvidence[] = [];
  let owned: OwnedWorkspace | undefined;
  let attemptedCreate = false, branchAttempted = false, candidateCommit: string | undefined;
  const startedAt = Date.now(), branch = `smoke/${randomBytes(16).toString("hex")}`;
  let monitorEvidence: MonitorEvidence | null = null;
  let runtimeVersions: OrdinaryRuntimeVersions;
  let inference: Awaited<ReturnType<typeof executeOwnedInference>>;
  let sessionModel: Awaited<ReturnType<typeof verifyOwnedSessionModel>>;
  let auxiliaryVm: Awaited<ReturnType<typeof verifyAuxiliaryVm>> | null = null;
  const lanes: Array<{ readonly name: string; readonly status: "PASS" | "BLOCKED"; readonly reason?: string }> = [];
  const progress = (step: string, phase: "pass" | "progress" | "incomplete" = "pass"): void => { options.onProgress?.(step, phase); };
  try {
    attemptedCreate = true;
    const created = await checked(profile, "workspace creation", [
      "create", profile.source, profile.workspace, "--ref", profile.workspaceSourceSha, ...(profile.image === undefined ? [] : ["--image", profile.image]),
      "--git-user-name", "DIM selected-host smoke", "--git-user-email", "dim-smoke@example.invalid", "--json"
    ]);
    owned = ownedWorkspaceName(profile.workspace, json(created.stdout, "created workspace"));
    if (profile.image !== undefined && record(json(created.stdout, "created workspace"), "created workspace").image !== profile.image) throw new OperatorInputError("created workspace did not retain the exact immutable image binding");
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
    await checked(profile, "owned workspace OpenCode setup", ["tools", "setup", owned.name, "opencode"], 10 * 60_000, { kind: "opencode-setup", ...owned });
    if (process.env.DIM_PRACTICAL_CI_REQUIRED === "1") await configureCiConsumer({ workspace: owned, profile, run: (step, args) => checked(profile, step, args) });

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

    inference = await executeOwnedInference({ profile, workspace: owned, run: (step, args, timeout) => checked(profile, step, args, timeout) });
    const llmToken = (await checked(profile, "LLM tool result", ["exec", owned.name, "--", "cat", "selected-host-llm.txt"])).stdout.trim();
    if (llmToken !== token) throw new SmokeFailure(profile.name, "LLM tool result", "the model did not reproduce the private challenge through a file tool");
    progress("explicit DIM provider/model, owned session, concrete file tools and nonce-correlated scoped router accounting");
    lanes.push({ name: "scoped-router-model-tool-accounting", status: "PASS" });
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
    const url = selectExposureUrl(exposure, { workspace: owned.name, ingress: profile.ingress, port: 4096, protocol: "http", containers: [] });
    await expectAuthenticationBoundary(url);
    progress("shared ingress credential boundary");
    const credentialOutput = await checked(profile, "OpenCode public capability credentials", ["tools", "console", "invoke", "server.credentials", "--input", JSON.stringify({ workspace: owned.name, workspaceId: owned.id }), "--json"]);
    const credentials = record(json(credentialOutput.stdout, "server credentials"), "server credentials");
    const client = authenticatedMonitorClient(url, { username: text(credentials["username"], "server username"), password: text(credentials["password"], "server password") }, inference.directory);
    const session = record(await client.get(`/session/${inference.sessionId}`, 30_000), "owned authenticated OpenCode session");
    if (session.id !== inference.sessionId) throw new SmokeFailure(profile.name, "OpenCode session", "authenticated API did not return this run's exact fresh session");
    sessionModel = await verifyOwnedSessionModel(client, inference);
    progress("authenticated OpenCode session through shared ingress");
    endpoints.push({ kind: "coding-agent", url, disposition: "verified-then-discarded" });
    lanes.push({ name: "opencode-authenticated-session-ingress", status: "PASS" });
    if (profile.vm !== undefined) {
      auxiliaryVm = await verifyAuxiliaryVm({ workspace: owned, image: profile.vm.image, startupTimeoutMilliseconds: profile.vm.startupTimeoutMilliseconds, challenge: token,
        run: (step, args, timeout) => checked(profile, step, args, timeout, step === "auxiliary VM readiness" ? { kind: "auxiliary-readiness", name: args[2]!, id: args[4]! } : undefined),
        rejected: async (step, args) => { const result = await dim(profile.name, args, true); if (result.exitCode === 0) throw new SmokeFailure(profile.name, step, "revoked operation unexpectedly succeeded"); } });
      lanes.push({ name: "auxiliary-kvm-vm", status: "PASS" });
    } else lanes.push({ name: "auxiliary-kvm-vm", status: "BLOCKED", reason: "Profile requires vm plugin, reviewed Incus host/image and explicit operator provisioning authority" });

    {
      progress("OpenCode monitor: reading bounded public session metadata", "progress");
      monitorEvidence = await inspectConfiguredMonitor({ profile: profile.monitor ?? ownedMonitorDefaults, workspace: owned.name, endpoint: url, sessionId: inference.sessionId, directory: inference.directory,
        credentials: { username: text(credentials["username"], "server username"), password: text(credentials["password"], "server password") },
        run: (step, args, timeout) => checked(profile, step, args, timeout) });
      progress(`OpenCode monitor: ${monitorEvidence.state}; discovery=${monitorEvidence.discovery}; completion=${monitorEvidence.completion}`, monitorInspection(monitorEvidence) === "inspected" ? "pass" : "incomplete");
      if (!monitorEvidence.sessions.some(({ sessionId }) => sessionId === inference.sessionId)) throw new OperatorInputError("monitor did not inspect the fresh owned inference session");
      lanes.push({ name: "owned-opencode-session-monitor", status: monitorInspection(monitorEvidence) === "inspected" ? "PASS" : "BLOCKED", ...(monitorInspection(monitorEvidence) === "inspected" ? {} : { reason: "fresh-session metadata inspection is incomplete" }) });
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
    await waitForAuthenticationBoundary(url, async () => {
      const status = record(json((await checked(profile, "recreated OpenCode failure status", ["tools", "server", recreated.name, "status", "--json"], 15_000)).stdout, "recreated server status"), "recreated server status");
      return status.state === "running" || status.state === "stopped" ? status.state : "unavailable";
    });
    await expectSmokeApplication(applicationUrl, token);
    const recoveredSession = record(await client.get(`/session/${inference.sessionId}`, 30_000), "recovered owned session");
    if (recoveredSession.id !== inference.sessionId) throw new SmokeFailure(profile.name, "OpenCode recovery", "authentication or the owned session did not survive recreation");
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
  return { workspace: owned, runtimeVersions, auxiliaryVm, inference, sessionModel, monitor: monitorEvidence, lanes, commands, endpoints };
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

export function authenticationBoundaryObservation(error: unknown): string {
  if (error instanceof Error) {
    const status = /^shared ingress must reach the credential boundary \(expected HTTP 401, received ([0-9]{3})\)$/.exec(error.message)?.[1];
    if (status) return `HTTP ${status}`;
    if (error.name === "TimeoutError" || error.name === "AbortError") return "request timeout or cancellation";
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"].includes(code)) return code;
  }
  return "request failed";
}

async function waitForAuthenticationBoundary(url: string, inspectServer: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await expectAuthenticationBoundary(url); return; }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let backend = "unavailable";
  try { backend = await inspectServer(); } catch { /* Retain the original boundary failure if status itself is unavailable. */ }
  throw new OperatorInputError(`shared ingress did not reconnect to the recreated owned server (last: ${authenticationBoundaryObservation(last)}; owned server: ${backend})`, { cause: last });
}
