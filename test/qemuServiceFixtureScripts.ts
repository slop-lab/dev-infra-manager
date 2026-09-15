export function spawnPreloadScript(): string {
  return `import childProcess from "node:child_process";
import fs, { appendFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
const originalKill = process.kill;
childProcess.spawn = function instrumentedSpawn(command, args, options) {
  appendFileSync(process.env.DIM_TEST_SPAWN_RECORD, JSON.stringify({ command, arguments: args ?? [] }) + "\\n");
  return originalSpawn.call(childProcess, command, args, options);
};
if (process.env.DIM_TEST_RESIDUAL_GROUP === "1") {
  process.kill = function retainedGroup(pid, signal) {
    if (pid < 0 && (signal === 0 || signal === "SIGTERM" || signal === "SIGKILL")) return true;
    return originalKill.call(process, pid, signal);
  };
}
if (process.env.DIM_TEST_REJECT_READDIR === "1") {
  fs.promises.readdir = async function rejectedReaddir() { throw new Error("DIM_TEST_READDIR_FORBIDDEN"); };
}
if (process.env.DIM_TEST_FORCE_BACKPRESSURE === "1") {
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function forcedBackpressure(...args) {
    originalWrite.apply(this, args);
    return false;
  };
}
syncBuiltinESMExports();
`;
}

export function launcherScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$DIM_TEST_LAUNCHER_PID"
printf '%s\n' "$DIM_QEMU_INPUT_SNAPSHOTS_JSON" >>"$DIM_TEST_LAUNCH_RECORD"
printf 'ready\n'
if [[ "$DIM_TEST_LEADER_EXITS" == 1 ]]; then
  bash -c 'trap "" HUP; exec sleep 86400' &
  printf '%s\n' "$!" >"$DIM_TEST_DESCENDANT_PID"
  exit 0
fi
[[ "$DIM_TEST_LAUNCHER_MODE" != exit ]] || exit 0
if [[ "$DIM_TEST_IGNORE_TERM" == 1 ]]; then
  trap '' TERM INT
  bash -c 'trap "" TERM INT; exec sleep 86400' &
else
  sleep 86400 &
  trap 'kill "$sleeper" >/dev/null 2>&1 || true; wait "$sleeper" 2>/dev/null || true; printf stopped >"$DIM_TEST_LAUNCHER_STOPPED"; exit 0' TERM INT
fi
sleeper=$!
wait "$sleeper"
`;
}
