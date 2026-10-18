import { UserError } from "../errors.js";

export function validateWorkspacePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new UserError("workspace port must be an integer between 1 and 65535");
}

/** Executed inside the workspace, with no host address or shell interpolation. */
export const workspacePortBridge = String.raw`
const net = require("node:net");
const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]), allowHalfOpen: true });
const fail = (error) => {
  process.stderr.write("workspace connection failed: " + error.message + "\n");
  process.exitCode = 1;
  socket.destroy();
};
socket.once("connect", () => process.stdin.pipe(socket));
socket.pipe(process.stdout, { end: false });
socket.once("end", () => process.stdout.end());
socket.once("error", fail);
process.once("SIGTERM", () => socket.destroy());
process.stdin.once("error", fail);
process.stdout.once("error", () => socket.destroy());
socket.once("close", () => {
  process.stdin.unpipe(socket);
  process.stdin.destroy();
  if (!process.stdout.writableEnded) process.stdout.end();
});
`;

export const workspacePortBridgeMarker = "dim-workspace-port-bridge";

/** Kill only this connection's marked process, inside its already verified container. */
export const workspacePortCleanup = String.raw`
const fs = require("node:fs");
const token = process.argv[1];
const matches = (pid) => {
  try {
    const args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter(Boolean);
    return args.at(-2) === "dim-workspace-port-bridge" && args.at(-1) === token;
  } catch { return false; }
};
const signal = (pid, name) => { try { process.kill(Number(pid), name); } catch (error) { if (error.code !== "ESRCH") throw error; } };
(async () => {
  const owned = fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid) && matches(pid));
  for (const pid of owned) signal(pid, "SIGTERM");
  const deadline = Date.now() + 750;
  while (owned.some(matches) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  for (const pid of owned.filter(matches)) signal(pid, "SIGKILL");
  const killedDeadline = Date.now() + 500;
  while (owned.some(matches) && Date.now() < killedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (owned.some(matches)) throw new Error("owned workspace connection did not exit");
})().catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
`;
