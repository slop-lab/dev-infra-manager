// @ts-check
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

// A real child process implementing the host transport envelope, without Docker.
const offset = process.argv[2] === "--state" ? 4 : 2;
if (process.argv[offset] !== "__host") throw new Error("expected hidden host operation");
const encoded = process.argv[offset + 1];
if (encoded === undefined) throw new Error("expected encoded host request");
/** @type {unknown} */
const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
if (!isRecord(request) || typeof request.operation !== "string") throw new Error("invalid host request");
const statePath = process.argv[3];
/** @type {unknown} */
const state = offset === 4 && statePath !== undefined ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
if (state !== undefined && (!isRecord(state) || typeof state.id !== "string")) throw new Error("invalid workspace fixture state");
if (request.operation === "ignorecancel") {
  process.on("SIGTERM", () => {});
  process.stdout.write("ready");
  setInterval(() => {}, 1000);
} else if (request.operation === "fail") {
  process.stderr.write("source acquisition failed\n");
  process.exitCode = 2;
} else if (request.operation === "invalid") {
  process.stdout.write("not JSON");
} else if (request.operation === "show" && state) {
  process.stdout.write(JSON.stringify(state));
} else if (request.operation === "connect" && isRecord(state)) {
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
} else if (request.operation === "exec") {
  if (!isRecord(request.input) || typeof request.input.exitCode !== "number" || !Number.isInteger(request.input.exitCode)
    || request.input.exitCode < 0 || request.input.exitCode > 255) throw new Error("invalid exec exit status");
  const exitCode = request.input.exitCode;
  process.stderr.write("exec stderr\n");
  process.stdin.pipe(process.stdout);
  process.stdin.on("end", () => { process.exitCode = exitCode; });
} else {
  process.stdout.write(JSON.stringify({ request }));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
