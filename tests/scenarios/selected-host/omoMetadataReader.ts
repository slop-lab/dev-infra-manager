import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { parseOmoTeamMetadata, type OmoTeamMetadata } from "./monitorMetadata.ts";

export async function readOmoTeamMetadata(input: {
  readonly baseDirectory: string; readonly maxRuns: number; readonly maxMembers: number; readonly deadlineMs: number;
}): Promise<OmoTeamMetadata> {
  const unavailable: OmoTeamMetadata = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: false };
  const runtime = join(input.baseDirectory, "runtime"), deadline = Date.now() + input.deadlineMs;
  try {
    for (const path of [input.baseDirectory, runtime]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) return { ...unavailable, unreadable: true };
    }
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? unavailable : { ...unavailable, unreadable: true };
  }
  const teams: OmoTeamMetadata["teams"][number][] = []; let runs = 0, remainingMembers = input.maxMembers, truncated = false, unreadable = false;
  const directory = await opendir(runtime);
  for await (const entry of directory) {
    if (Date.now() >= deadline) { truncated = true; break; }
    if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.name)) continue;
    if (runs++ >= input.maxRuns) { truncated = true; break; }
    try {
      const runPath = join(runtime, entry.name), info = await lstat(runPath);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) { unreadable = true; continue; }
      const file = await open(join(runPath, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) { unreadable = true; continue; }
        const state: unknown = JSON.parse(await file.readFile("utf8"));
        if (!state || typeof state !== "object" || Array.isArray(state)) { unreadable = true; continue; }
        const projected = parseOmoTeamMetadata({ source: "runtime", teams: [{ ...state, modifiedAt: metadata.mtime.toISOString() }] }, 1, remainingMembers);
        const team = projected.teams[0];
        if (team) { teams.push(team); remainingMembers -= team.members.length; }
        if (projected.truncated) truncated = true;
      } finally { await file.close(); }
    } catch { unreadable = true; }
  }
  return parseOmoTeamMetadata({ source: "optional-omo-adapter", enabled: null, teams, truncated, unreadable }, input.maxRuns, input.maxMembers);
}
