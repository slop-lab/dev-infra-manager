import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

// Frozen v1 peer: intentionally imports neither current contracts nor host code.
// New clients must keep working against this independent older implementation.
const offset = process.argv[2] === "--state" ? 4 : 2;
if (process.argv[offset] !== "__host") throw new Error("expected hidden host operation");
const encoded = process.argv[offset + 1];
if (encoded === undefined) throw new Error("expected encoded host request");

const request: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
if (!isRecord(request) || request.protocol !== "dim.cli-host" || request.version !== 1 || typeof request.operation !== "string") throw new Error("invalid host request");
const statePath = process.argv[3];

const state: unknown = offset === 4 && statePath !== undefined ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
if (state !== undefined && (!isRecord(state) || typeof state.id !== "string")) throw new Error("invalid workspace fixture state");
const args = isRecord(request.input) && Array.isArray(request.input.args) ? request.input.args : [];
if (request.operation === "capabilities") {
  process.stdout.write(JSON.stringify({protocol:"dim.cli-host",versions:JSON.parse(process.env.DIM_TEST_VERSIONS ?? "[1]"),hostRelease:"0.1.0-frozen-v1"}));
} else if (request.operation === "command" && args[0] === "ignorecancel") {
  process.on("SIGTERM", () => {});
  process.stdout.write("ready");
  setInterval(() => {}, 1000);
} else if (request.operation === "command" && args[0] === "wait") {
  process.stdout.write("ready"); setInterval(() => {}, 1000);
} else if (request.operation === "command" && args[0] === "fail") {
  process.stderr.write("source acquisition failed\n");
  process.exitCode = 2;
} else if (request.operation === "command" && args[0] === "invalid") {
  process.stdout.write("not JSON");
} else if (request.operation === "workspace.endpoint" && isRecord(state)) {
  process.stdout.write(JSON.stringify({workspaceId:state.id,runtimeStatus:state.runtimeStatus}));
} else if (request.operation === "workspace.connect" && isRecord(state)) {
  if (!isRecord(request.input) || typeof request.input.port !== "number" || !Number.isInteger(request.input.port)
    || request.input.port < 1 || request.input.port > 65535) throw new Error("invalid workspace connection input");
  if (request.input.workspaceId !== state.id) {
    process.stderr.write("workspace was replaced; restart forwarding\n");
    process.exitCode = 2;
  } else {
    const socket = createConnection({ host: "127.0.0.1", port: request.input.port, allowHalfOpen: true });
    socket.on("connect", () => process.stdin.pipe(socket));
    socket.pipe(process.stdout, { end: false });
    socket.on("end", () => process.stdout.end());
    socket.on("error", (error) => { process.stderr.write(error.message); process.exitCode = 1; socket.destroy(); });
    socket.on("close", () => { process.stdin.destroy(); if (!process.stdout.writableEnded) process.stdout.end(); });
  }
} else if (request.operation === "command" && args[0] === "exec") {
  const exitCode = Number(args[1]);
  process.stderr.write("exec stderr\n");
  process.stdin.pipe(process.stdout);
  process.stdin.on("end", () => { process.exitCode = exitCode; });
} else {
  process.stdout.write(JSON.stringify({ request }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
