import type { OwnedMonitorProfile } from "./config.js";
import { inspectOpenCodeMonitor, parseOmoTeamMetadata, type MonitorEvidence, type OmoTeamMetadata } from "./monitor.js";
import { authenticatedMonitorClient } from "./monitorClient.js";
import type { CommandResult } from "../web-lifecycle/process.js";

export async function inspectConfiguredMonitor(input: {
  readonly profile: OwnedMonitorProfile; readonly workspace: string; readonly endpoint: string; readonly sessionId: string; readonly directory: string;
  readonly credentials: { readonly username: string; readonly password: string };
  readonly run: (step: string, args: readonly string[], timeout: number) => Promise<CommandResult>;
}): Promise<MonitorEvidence> {
  const { profile } = input, deadline = Date.now() + profile.deadlineSeconds * 1000;
  let team: OmoTeamMetadata = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: false };
  if (profile.omoMetadataPath !== undefined) {
    const raw = await input.run("optional OMO metadata adapter", ["exec", input.workspace, "--", "cat", profile.omoMetadataPath], Math.max(1, deadline - Date.now()));
    team = parseOmoTeamMetadata(JSON.parse(raw.stdout), profile.maxSessions, profile.maxSessions);
  }
  return inspectOpenCodeMonitor({ parentSessionId: input.sessionId, directory: input.directory,
    maxSessions: profile.maxSessions, maxDepth: profile.maxDepth, maxRequests: profile.maxRequests,
    recentMessages: profile.recentMessages, staleMinutes: profile.staleMinutes,
    deadlineMs: Math.max(1, deadline - Date.now()), requestTimeoutMs: profile.requestTimeoutSeconds * 1_000
  }, team, authenticatedMonitorClient(input.endpoint, input.credentials, input.directory));
}
