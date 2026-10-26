export type OmoTeamMetadata = {
  readonly source: string; readonly enabled: boolean | null;
  readonly teams: readonly { readonly leadSessionId: string | null; readonly status: string;
    readonly members: readonly { readonly sessionId: string | null; readonly status: string }[]; readonly modifiedAt: string }[];
  readonly truncated: boolean; readonly unreadable: boolean;
};
export function monitorStatus(value: unknown): string {
  return typeof value === "string" && ["active", "running", "creating", "shutdown_requested", "idle", "busy", "retry", "errored", "error", "completed", "stopped", "pending", "failed", "shutdown"].includes(value) ? value : "unknown";
}
export function parseOmoTeamMetadata(value: unknown, maximumTeams: number, maximumMembers: number): OmoTeamMetadata {
  const root = record(value), rawTeams = array(root["teams"]);
  let truncated = root["truncated"] === true || rawTeams.length > maximumTeams;
  let remainingMembers = maximumMembers;
  const teams = rawTeams.slice(0, maximumTeams).map((raw) => {
    const team = record(raw), rawMembers = array(team["members"]);
    if (rawMembers.length > remainingMembers) truncated = true;
    const selectedMembers = rawMembers.slice(0, remainingMembers); remainingMembers -= selectedMembers.length;
    const modified = team["modifiedAt"];
    return { leadSessionId: id(team["leadSessionId"]), status: monitorStatus(team["status"]),
      members: selectedMembers.map((rawMember) => {
        const member = record(rawMember); return { sessionId: id(member["sessionId"]), status: monitorStatus(member["status"]) };
      }), modifiedAt: typeof modified === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(modified) && Number.isFinite(Date.parse(modified)) ? modified : "unknown",
    };
  });
  return { source: root["source"] === "unavailable" ? "unavailable" : "optional-omo-adapter",
    enabled: typeof root["enabled"] === "boolean" ? root["enabled"] : null, teams, truncated, unreadable: root["unreadable"] === true };
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function id(value: unknown): string | null { return typeof value === "string" && /^ses_[A-Za-z0-9]{1,100}$/.test(value) ? value : null; }
