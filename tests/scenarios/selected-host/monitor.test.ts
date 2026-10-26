import { describe, expect, it } from "vitest";
import { inspectOpenCodeMonitor, parseOmoTeamMetadata, type MonitorClient, type MonitorOptions, type OmoTeamMetadata } from "./monitor.js";

const now = Date.parse("2026-10-26T06:00:00.000Z");
const options: MonitorOptions = {
  parentSessionId: "ses_parent",
  directory: "/workspace/main",
  maxSessions: 8,
  maxDepth: 4,
  maxRequests: 32,
  recentMessages: 4,
  staleMinutes: 15,
  deadlineMs: 5_000,
  requestTimeoutMs: 500,
  observedAtMs: now
};

function client(values: Readonly<Record<string, unknown>>): MonitorClient {
  return { async get(path) {
    if (!(path in values)) throw new Error(`unexpected fixture request: ${path}`);
    return values[path];
  } };
}

const noTeams: OmoTeamMetadata = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: false };

describe("inspectOpenCodeMonitor", () => {
  it("Given an idle parent and recursively discovered busy child, when inspected, then aggregate activity remains active", async () => {
    const result = await inspectOpenCodeMonitor(options, noTeams, client({
      "/session/status": { ses_parent: { type: "idle" }, ses_child: { type: "busy" } },
      "/session?limit=8": [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message?limit=4": [],
      "/session/ses_parent/children": [{ id: "ses_child", parentID: "ses_parent" }],
      "/session/ses_child/message?limit=4": [{ info: { role: "assistant", time: { completed: now } }, parts: [] }],
      "/session/ses_child/children": []
    }));
    expect(result.state).toBe("active");
    expect(result.parent).toBe("idle");
    expect(result.activeChildren).toBe(1);
    expect(result.completion).toBe("not-assessed");
  });

  it("uses the children endpoint relationship independently of list parentID metadata", async () => {
    const result = await inspectOpenCodeMonitor(options, noTeams, client({
      "/experimental/tool/ids": [], "/session/status": { ses_child: { type: "busy" } }, "/session?limit=8": [{ id: "ses_parent" }], "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message?limit=4": [], "/session/ses_parent/children": [{ id: "ses_child" }],
      "/session/ses_child/message?limit=4": [], "/session/ses_child/children": [],
    }));
    expect(result.state).toBe("active"); expect(result.activeChildren).toBe(1);
  });

  it("Given an OMO member marked idle while its API session is busy, when inspected, then both sources and their disagreement are preserved", async () => {
    const teams: OmoTeamMetadata = { source: "fixture", enabled: true, truncated: false, unreadable: false,
      teams: [{ leadSessionId: "ses_parent", status: "active", members: [{ sessionId: "ses_team", status: "idle" }], modifiedAt: "2026-10-26T05:59:00.000Z" }] };
    const result = await inspectOpenCodeMonitor(options, teams, client({
      "/session/status": { ses_parent: { type: "idle" }, ses_team: { type: "busy" } },
      "/session?limit=8": [{ id: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message?limit=4": [], "/session/ses_parent/children": [],
      "/session/ses_team/message?limit=4": [], "/session/ses_team/children": []
    }));
    expect(result.sessions.find(({ sessionId }) => sessionId === "ses_team"))
      .toMatchObject({ activity: "active", omoStatus: "idle", sourceDisagreement: true });
  });

  it("Given idle discovery truncated before an unseen child, when inspected, then aggregate state is unknown rather than complete or idle", async () => {
    const result = await inspectOpenCodeMonitor({ ...options, maxSessions: 1 }, noTeams, client({
      "/session/status": { ses_parent: { type: "idle" } },
      "/session?limit=1": [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message?limit=4": [],
      "/session/ses_parent/children": [{ id: "ses_child", parentID: "ses_parent" }]
    }));
    expect(result.state).toBe("unknown");
    expect(result.discovery).toBe("bounded-truncated");
  });

  it("Given a busy session with old metadata, when inspected, then it remains active-stale rather than becoming complete", async () => {
    const result = await inspectOpenCodeMonitor(options, noTeams, client({
      "/session/status": { ses_parent: { type: "busy" } }, "/session?limit=8": [{ id: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent", time: { updated: now - 60 * 60_000 } },
      "/session/ses_parent/message?limit=4": [], "/session/ses_parent/children": []
    }));
    expect(result.state).toBe("active");
    expect(result.parent).toBe("active-stale");
    expect(result.completion).toBe("not-assessed");
  });

  it("Given current and historical failed children, when inspected, then current failure and historical failure remain distinct", async () => {
    const old = now - 60 * 60_000;
    const error = { name: "ProviderAuthError", data: { statusCode: 401 } };
    const result = await inspectOpenCodeMonitor(options, noTeams, client({
      "/experimental/tool/ids": [],
      "/session/status": { ses_parent: { type: "idle" }, ses_current: { type: "idle" }, ses_old: { type: "idle" } },
      "/session?limit=8": [{ id: "ses_parent" }, { id: "ses_current", parentID: "ses_parent" }, { id: "ses_old", parentID: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent" }, "/session/ses_parent/message?limit=4": [],
      "/session/ses_parent/children": [{ id: "ses_current", parentID: "ses_parent" }, { id: "ses_old", parentID: "ses_parent" }],
      "/session/ses_current/message?limit=4": [{ info: { role: "assistant", error, time: { completed: now } }, parts: [] }],
      "/session/ses_current/children": [],
      "/session/ses_old/message?limit=4": [{ info: { role: "assistant", error, time: { completed: old } }, parts: [] }],
      "/session/ses_old/children": []
    }));
    expect(result.state).toBe("error");
    expect(result.currentFailures).toBe(1);
    expect(result.historicalFailures).toBe(1);
  });

  it("Given private prompt, thinking and tool payloads, when evidence is built, then only bounded metadata survives", async () => {
    const secret = "PRIVATE-PROMPT-TOOL-OUTPUT";
    const result = await inspectOpenCodeMonitor(options, noTeams, client({
      "/session/status": { ses_parent: { type: "busy" } }, "/session?limit=8": [{ id: "ses_parent" }],
      "/session/ses_parent": { id: "ses_parent" }, "/session/ses_parent/children": [],
      "/session/ses_parent/message?limit=4": [{ info: { role: "assistant", time: { completed: now } },
        prompt: secret, thinking: secret, parts: [{ type: "tool", tool: "bash", state: { status: "running", input: secret, output: secret } }] }]
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.sessions[0]?.runningTools).toEqual([{ tool: "bash", status: "running" }]);
  });

  it("preserves known API activity when session discovery and messages are only partially readable", async () => {
    const result = await inspectOpenCodeMonitor(options, noTeams, client({ "/session/status": { ses_parent: { type: "busy" } } }));
    expect(result.state).toBe("active"); expect(result.discovery).toBe("partial");
    expect(result.completion).toBe("not-assessed");
  });

  it("reports an exhausted discovery budget as incomplete, not unreachable or all idle", async () => {
    const result = await inspectOpenCodeMonitor({ ...options, maxRequests: 1 }, noTeams, client({ "/experimental/tool/ids": [] }));
    expect(result.state).toBe("unknown"); expect(result.discovery).toBe("bounded-truncated"); expect(result.requestCount).toBe(1);
  });

  it("does not assert all idle when optional team discovery is unreadable", async () => {
    const result = await inspectOpenCodeMonitor(options, noTeams, client({
      "/session/status": {}, "/session?limit=8": [{ id: "ses_parent" }], "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message?limit=4": [], "/session/ses_parent/children": [],
    }));
    expect(result.state).toBe("unknown"); expect(result.discovery).toBe("partial"); expect(result.completion).toBe("not-assessed");
  });

  it("redacts untrusted OMO source labels, statuses and timestamps from evidence", async () => {
    const secret = "PRIVATE-METADATA-CREDENTIAL";
    const team: OmoTeamMetadata = { source: secret, enabled: true, truncated: false, unreadable: false,
      teams: [{ leadSessionId: "ses_parent", status: secret, modifiedAt: secret, members: [] }] };
    const result = await inspectOpenCodeMonitor(options, team, client({
      "/session/status": {}, "/session?limit=8": [{ id: "ses_parent" }], "/session/ses_parent": { id: "ses_parent", parentID: secret },
      "/session/ses_parent/message?limit=4": [], "/session/ses_parent/children": [],
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.parent).toBe("idle");
  });

  it("bounds total team membership rather than multiplying the member budget by team count", () => {
    const team = { leadSessionId: "ses_parent", status: "active", modifiedAt: "2026-10-26T06:00:00Z",
      members: [{ sessionId: "ses_one", status: "idle" }, { sessionId: "ses_two", status: "idle" }] };
    const parsed = parseOmoTeamMetadata({ source: "runtime", teams: [team, team] }, 2, 2);
    expect(parsed.teams.reduce((count, entry) => count + entry.members.length, 0)).toBe(2); expect(parsed.truncated).toBe(true);
  });

  it("applies the same depth bound to nested OMO leads and reports their uninspected descendants as incomplete", async () => {
    const team: OmoTeamMetadata = { source: "runtime", enabled: true, truncated: false, unreadable: false, teams: [
      { leadSessionId: "ses_parent", status: "active", modifiedAt: "2026-10-26T06:00:00Z", members: [{ sessionId: "ses_lead", status: "idle" }] },
      { leadSessionId: "ses_lead", status: "active", modifiedAt: "2026-10-26T06:00:00Z", members: [{ sessionId: "ses_hidden", status: "active" }] },
    ] };
    const result = await inspectOpenCodeMonitor({ ...options, maxDepth: 1 }, team, client({
      "/experimental/tool/ids": ["team_create"], "/session/status": {}, "/session?limit=8": [{ id: "ses_parent" }], "/session/ses_parent": { id: "ses_parent" },
      "/session/ses_parent/message?limit=4": [], "/session/ses_parent/children": [], "/session/ses_lead/message?limit=4": [], "/session/ses_lead/children": [],
    }));
    expect(result.state).toBe("unknown"); expect(result.discovery).toBe("bounded-truncated");
    expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual(["ses_parent", "ses_lead"]);
  });
});
