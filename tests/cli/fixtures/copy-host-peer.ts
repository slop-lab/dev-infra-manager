import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { workspaceCopyGuest, workspaceCopyMarker } from "../../../packages/host/core/src/workspace/copy.js";

const encoded = process.argv.at(-1);
if (process.argv.at(-2) !== "__host" || encoded === undefined) throw new Error("expected hidden host operation");
const request: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
if (!record(request) || request.protocol !== "dim.cli-host" || request.version !== 1 || typeof request.operation !== "string") throw new Error("invalid host request");
if (request.operation === "capabilities") process.stdout.write(JSON.stringify({ protocol: "dim.cli-host", versions: [1] }));
else if (request.operation === "workspace.endpoint") {
  if (process.env.DIM_COPY_READY_FILE) writeFileSync(process.env.DIM_COPY_READY_FILE, "ready");
  process.stdout.write(JSON.stringify({ workspaceId: workspaceId(), runtimeStatus: "running" }));
}
else if (request.operation === "command") await copy(request.input);
else throw new Error("unsupported fixture operation");

async function copy(input: unknown): Promise<void> {
  if (!record(input) || !Array.isArray(input.args) || !input.args.every((argument) => typeof argument === "string")) throw new Error("invalid command request");
  const args = input.args;
  const expectedIndex = args.indexOf("--expect-id");
  if (args[0] !== "cp" || expectedIndex < 0 || args[expectedIndex + 1] !== workspaceId()) {
    process.stderr.write("workspace identity changed; the old session cannot control its replacement\n"); process.exitCode = 2; return;
  }
  const source = args[1] ?? ""; const destination = args[2] ?? "";
  const remote = source === "-" ? destination : source;
  const separator = remote.indexOf(":");
  const guestPath = remote.slice(separator + 1).replace(/^\/+/, "");
  const root = process.env.DIM_COPY_GUEST_ROOT;
  if (!root || separator < 1 || guestPath.split("/").includes("..")) throw new Error("invalid fixture guest path");
  if (guestPath === "fail-empty") { process.stderr.write("copy source failed\n"); process.exitCode = 2; return; }
  if (guestPath === "malicious-hang") {
    const entry = Buffer.from(JSON.stringify({ path: "../escape", type: "file", mode: 0o600, size: 0 }));
    const length = Buffer.alloc(4); length.writeUInt32BE(entry.length);
    process.stdout.write(Buffer.concat([Buffer.from("DIMCP1\0", "ascii"), length, entry]));
    setInterval(() => {}, 1000); return;
  }
  const direction = source === "-" ? "receive" : "send";
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyGuest, direction,
    path.join(root, guestPath), args.includes("--recursive") ? "1" : "0", args.includes("--overwrite") ? "1" : "0", workspaceCopyMarker, "helper", randomUUID()], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = guestPath === "archive-exit-7" && status === 0 ? 7 : status;
}

function workspaceId(): string { return process.env.DIM_COPY_WORKSPACE_ID ?? "11111111-1111-4111-8111-111111111111"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
