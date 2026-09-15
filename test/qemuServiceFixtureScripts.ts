export function spawnPreloadScript(): string {
  return `import childProcess from "node:child_process";
import fs, { appendFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
const originalKill = process.kill;
const originalRm = fs.promises.rm;
childProcess.spawn = function instrumentedSpawn(command, args, options) {
  appendFileSync(process.env.DIM_TEST_SPAWN_RECORD, JSON.stringify({
    command, arguments: args ?? [], cwd: options.cwd, sourceRoot: options.env.DIM_QEMU_SOURCE_ROOT,
  }) + "\\n");
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
fs.promises.rm = async function instrumentedRm(target, options) {
  const trigger = process.env.DIM_TEST_REJECT_SNAPSHOT_RM_TRIGGER;
  const record = process.env.DIM_TEST_REJECT_SNAPSHOT_RM_RECORD;
  const runsRoot = process.env.DIM_TEST_RUNS_ROOT;
  if (trigger !== undefined && record !== undefined && runsRoot !== undefined && typeof target === "string"
    && target.startsWith(runsRoot + "/run-") && !target.slice(runsRoot.length + 1).includes("/")
    && options?.recursive === true && options.force === true) {
    try {
      fs.renameSync(trigger, record);
      appendFileSync(record, target + "\\n");
      throw new Error("DIM_TEST_SNAPSHOT_RM_FAILURE " + target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return originalRm.call(fs.promises, target, options);
};
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
