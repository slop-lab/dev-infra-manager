import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

// A real child process implementing the host transport envelope, without Docker.
const offset = process.argv[2] === "--state" ? 4 : 2;
if (process.argv[offset] !== "__host") throw new Error("expected hidden host operation");
const request = JSON.parse(Buffer.from(process.argv[offset + 1], "base64url").toString("utf8"));
const state = offset === 4 ? JSON.parse(readFileSync(process.argv[3], "utf8")) : undefined;
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
} else if (request.operation === "connect" && state) {
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
  process.stderr.write("exec stderr\n");
  process.stdin.pipe(process.stdout);
  process.stdin.on("end", () => { process.exitCode = request.input.exitCode; });
} else {
  process.stdout.write(JSON.stringify({ request }));
}
