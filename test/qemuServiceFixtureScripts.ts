export function spawnPreloadScript(): string {
  return `import childProcess from "node:child_process";
import fs, { appendFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const originalSpawn = childProcess.spawn;
const originalKill = process.kill;
const originalLstat = fs.promises.lstat;
const originalRm = fs.promises.rm;
const originalCreateServer = http.createServer;
let serviceServer;
let socketIdentityErrorTriggered = false;
childProcess.spawn = function instrumentedSpawn(command, args, options) {
  appendFileSync(process.env.DIM_TEST_SPAWN_RECORD, JSON.stringify({
    command, arguments: args ?? [], cwd: options.cwd, sourceRoot: options.env.DIM_QEMU_SOURCE_ROOT,
  }) + "\\n");
  return originalSpawn.call(childProcess, command, args, options);
};
process.kill = function instrumentedKill(pid, signal) {
  if (pid < 0 && process.env.DIM_TEST_GROUP_SIGNAL_RECORD !== undefined) {
    appendFileSync(process.env.DIM_TEST_GROUP_SIGNAL_RECORD, String(signal) + "\\n");
  }
  if (process.env.DIM_TEST_RESIDUAL_GROUP === "1" && pid < 0
    && (signal === 0 || signal === "SIGTERM" || signal === "SIGKILL")) return true;
  return originalKill.call(process, pid, signal);
};
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
  if (process.env.DIM_TEST_BLOCK_SNAPSHOT_RM === "1" && runsRoot !== undefined && typeof target === "string"
    && target.startsWith(runsRoot + "/run-") && !target.slice(runsRoot.length + 1).includes("/")
    && options?.recursive === true && options.force === true) {
    appendFileSync(process.env.DIM_TEST_SNAPSHOT_RM_STARTED, target + "\\n");
    const release = process.env.DIM_TEST_SNAPSHOT_RM_RELEASE;
    await new Promise((resolveRelease, rejectRelease) => {
      const complete = () => {
        if (!fs.existsSync(release)) return;
        watcher.close();
        resolveRelease();
      };
      const watcher = fs.watch(path.dirname(release), (_event, filename) => {
        if (filename?.toString() === path.basename(release)) complete();
      });
      watcher.once("error", rejectRelease);
      complete();
    });
  }
  return originalRm.call(fs.promises, target, options);
};
fs.promises.lstat = async function instrumentedLstat(target, options) {
  const result = await originalLstat.call(fs.promises, target, options);
  const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET;
  if (!socketIdentityErrorTriggered && process.env.DIM_TEST_ERROR_AFTER_SOCKET_IDENTITY === "1"
    && socketPath !== undefined && target === socketPath && result.isSocket()) {
    socketIdentityErrorTriggered = true;
    appendFileSync(process.env.DIM_TEST_INITIALIZATION_ERROR_RECORD, "after-identity\\n");
    serviceServer.emit("error", Object.assign(new Error("DIM_TEST_ERROR_AFTER_SOCKET_IDENTITY"), { code: "EIO" }));
  }
  return result;
};
http.createServer = function instrumentedCreateServer(...args) {
  const server = originalCreateServer.apply(http, args);
  serviceServer = server;
  if (process.env.DIM_TEST_STARTUP_LISTEN_FAILURE === "1") {
    server.listen = function rejectedListen() {
      queueMicrotask(() => server.emit("error", Object.assign(new Error("DIM_TEST_STARTUP_LISTEN_FAILURE"), {
        code: "EADDRINUSE",
      })));
      return server;
    };
  }
  const closeRecord = process.env.DIM_TEST_SERVER_CLOSE_RECORD;
  if (closeRecord !== undefined) {
    const originalClose = server.close;
    server.close = function instrumentedClose(...closeArgs) {
      appendFileSync(closeRecord, "close\\n");
      if (process.env.DIM_TEST_ERROR_DURING_ROLLBACK === "1") {
        appendFileSync(process.env.DIM_TEST_INITIALIZATION_ERROR_RECORD, "during-rollback\\n");
        server.emit("error", Object.assign(new Error("DIM_TEST_ERROR_DURING_ROLLBACK"), { code: "EIO" }));
      }
      return originalClose.apply(this, closeArgs);
    };
  }
  const trigger = process.env.DIM_TEST_RUNTIME_SERVER_ERROR_TRIGGER;
  const errorRecord = process.env.DIM_TEST_RUNTIME_SERVER_ERROR_RECORD;
  if (trigger !== undefined && errorRecord !== undefined) {
    let triggered = false;
    const watcher = fs.watch(path.dirname(trigger), (_event, filename) => {
      if (triggered || filename?.toString() !== path.basename(trigger)) return;
      try {
        const payload = JSON.parse(fs.readFileSync(trigger, "utf8"));
        triggered = true;
        watcher.close();
        for (let index = 0; index < payload.count; index += 1) {
          const marker = "DIM_TEST_RUNTIME_SERVER_ERROR_" + (index + 1);
          appendFileSync(errorRecord, marker + ":listeners=" + server.listenerCount("error") + "\\n");
          server.emit("error", Object.assign(new Error(marker), { code: "EIO" }));
        }
        if (payload.signal === true) {
          appendFileSync(errorRecord, "SIGTERM\\n");
          process.kill(process.pid, "SIGTERM");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    });
    server.once("close", () => watcher.close());
  }
  return server;
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
