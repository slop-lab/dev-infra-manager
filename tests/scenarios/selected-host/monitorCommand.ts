import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseMonitorProfile, type MonitorProfile } from "./config.ts";
import { inspectOpenCodeMonitor, parseOmoTeamMetadata, type MonitorEvidence, type OmoTeamMetadata } from "./monitor.ts";
import { authenticatedMonitorClient } from "./monitorClient.ts";

export type Inspection = "inspected" | "incomplete" | "unavailable";
export type MonitorTarget = { readonly name: string; readonly serverOrigin: string; readonly monitor: MonitorProfile; readonly omoMetadataFile?: string };
type Credentials = { readonly username: string; readonly password: string };
export class MonitorInputError extends Error { readonly name = "MonitorInputError"; }

export function monitorInspection(evidence: MonitorEvidence): Inspection {
  if (evidence.state === "unreachable") return "unavailable";
  return evidence.state === "unknown" || evidence.discovery !== "complete-child-tree" ? "incomplete" : "inspected";
}

export function parseMonitorTargets(value: unknown): readonly MonitorTarget[] {
  const root = object(value);
  exact(root, ["schemaVersion", "targets"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.targets) || root.targets.length < 1 || root.targets.length > 200) throw new MonitorInputError("invalid monitor target collection");
  const targets = root.targets.map((raw: unknown) => {
    const row = object(raw); exact(row, ["name", "serverOrigin", "monitor", "omoMetadataFile"]);
    if (typeof row.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(row.name) || typeof row.serverOrigin !== "string") throw new MonitorInputError("invalid monitor target identity");
    const endpoint = new URL(row.serverOrigin);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new MonitorInputError("monitor target must use a credential-free HTTP(S) origin");
    const monitor = parseMonitorProfile(row.monitor, "target monitor");
    if (monitor.omoMetadataPath !== undefined) throw new MonitorInputError("standalone monitoring accepts local omoMetadataFile, not guest execution paths");
    const metadata = row.omoMetadataFile;
    if (metadata !== undefined && (typeof metadata !== "string" || !isAbsolute(metadata))) throw new MonitorInputError("OMO metadata file must be an explicit absolute path");
    return { name: row.name, serverOrigin: endpoint.origin, monitor, ...(metadata === undefined ? {} : { omoMetadataFile: metadata }) };
  });
  if (new Set(targets.map(({ name }) => name)).size !== targets.length) throw new MonitorInputError("monitor target names must be unique");
  return targets;
}

export function parseMonitorCredentials(value: unknown, names: readonly string[]): ReadonlyMap<string, Credentials> {
  const root = object(value); exact(root, ["schemaVersion", "credentials"]);
  if (root.schemaVersion !== 1) throw new MonitorInputError("invalid in-memory credential envelope");
  const supplied = object(root.credentials), result = new Map<string, Credentials>();
  for (const name of names) {
    if (!Object.hasOwn(supplied, name)) throw new MonitorInputError("selected target credential missing from stdin");
    const credential = object(supplied[name]); exact(credential, ["username", "password"]);
    if (typeof credential.username !== "string" || !/^[\x21-\x39\x3b-\x7e]{1,64}$/.test(credential.username)
      || typeof credential.password !== "string" || !/^[\x20-\x7e]{12,128}$/.test(credential.password)) throw new MonitorInputError("invalid selected server credential");
    result.set(name, { username: credential.username, password: credential.password });
  }
  return result;
}

export async function inspectMonitorTargets(targets: readonly MonitorTarget[], credentials: ReadonlyMap<string, Credentials>, progress?: (name: string, phase: "started" | Inspection) => void): Promise<{
  readonly outcome: Inspection; readonly completion: "not-assessed";
  readonly results: readonly { readonly target: string; readonly inspection: Inspection; readonly evidence: MonitorEvidence }[];
}> {
  const results = [];
  for (const target of targets) {
    const credential = credentials.get(target.name);
    if (!credential) throw new MonitorInputError("selected target credential missing");
    progress?.(target.name, "started");
    const deadline = Date.now() + target.monitor.deadlineSeconds * 1000;
    let team: OmoTeamMetadata = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: false };
    if (target.omoMetadataFile !== undefined) {
      try {
        const value = object(await boundedMonitorJson(target.omoMetadataFile));
        if (!Array.isArray(value.teams) || typeof value.truncated !== "boolean" || typeof value.unreadable !== "boolean") throw new MonitorInputError("invalid OMO metadata adapter output");
        team = parseOmoTeamMetadata(value, target.monitor.maxSessions, target.monitor.maxSessions);
      } catch { team = { ...team, unreadable: true }; }
    }
    const observed = await inspectOpenCodeMonitor({ ...target.monitor, deadlineMs: Math.max(1, deadline - Date.now()), requestTimeoutMs: target.monitor.requestTimeoutSeconds * 1000 }, team,
      authenticatedMonitorClient(target.serverOrigin, credential, target.monitor.directory));
    const selected = new Set(observed.sessions.map(({ sessionId }) => sessionId));
    const evidence = { ...observed, team: { ...observed.team, teams: observed.team.teams
      .filter(({ leadSessionId }) => leadSessionId !== null && selected.has(leadSessionId))
      .map((entry) => ({ ...entry, members: entry.members.filter(({ sessionId }) => sessionId !== null && selected.has(sessionId)) })) } };
    const inspection = monitorInspection(evidence);
    results.push({ target: target.name, inspection, evidence }); progress?.(target.name, inspection);
  }
  const outcome = results.some(({ inspection }) => inspection === "unavailable") ? "unavailable" : results.some(({ inspection }) => inspection === "incomplete") ? "incomplete" : "inspected";
  return { outcome, completion: "not-assessed", results };
}

export async function boundedMonitorJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) throw new MonitorInputError("monitor metadata requires a bounded owned regular file");
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw new MonitorInputError("monitor metadata exceeds its byte bound");
    try { const value: unknown = JSON.parse(buffer.toString("utf8", 0, size)); return value; }
    catch { throw new MonitorInputError("monitor metadata is not valid JSON"); }
  } finally { await file.close(); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MonitorInputError("monitor input must be an object");
  return Object.fromEntries(Object.entries(value));
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new MonitorInputError("unknown monitor input field; credentials belong only on stdin");
}
