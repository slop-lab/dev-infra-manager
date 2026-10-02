import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { NativeGitIdentity, NativeGitServiceConfig } from "./config.js";
import type { NativeGitRoute } from "./routing.js";

const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const BACKEND_TIMEOUT_MILLISECONDS = 30_000;

export function serveGitBackend(
  config: NativeGitServiceConfig,
  identity: NativeGitIdentity,
  route: NativeGitRoute,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  return new Promise((resolve) => {
  const child = spawn(config.gitExecutable, ["http-backend"], {
    env: backendEnvironment(config, identity, route, request),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let requestBytes = 0;
  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  let errorOutput = "";
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    request.resume();
    resolve();
  };
  const fail = (status: number): void => {
    child.kill("SIGKILL");
    if (!response.headersSent && !response.writableEnded) response.writeHead(status).end();
  };
  const timeout = setTimeout(() => fail(504), BACKEND_TIMEOUT_MILLISECONDS);
  timeout.unref();

  request.on("data", (chunk: Buffer) => {
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BYTES) {
      fail(413);
      return;
    }
    if (!child.stdin.destroyed && !child.stdin.write(chunk)) request.pause();
  });
  child.stdin.on("drain", () => request.resume());
  child.stdin.on("error", () => request.resume());
  request.on("end", () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
  request.on("aborted", () => child.kill("SIGKILL"));
  response.on("close", () => {
    if (!response.writableEnded) child.kill("SIGKILL");
  });

  child.stdout.on("data", (chunk: Buffer) => {
    if (response.writableEnded || response.destroyed) return;
    if (headersSent) {
      if (!response.write(chunk)) child.stdout.pause();
      return;
    }
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    if (headerBuffer.length > MAX_HEADER_BYTES) {
      fail(502);
      return;
    }
    const separator = headerBuffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    writeCgiHeaders(response, headerBuffer.subarray(0, separator));
    headersSent = true;
    const body = headerBuffer.subarray(separator + 4);
    if (body.length > 0) response.write(body);
    headerBuffer = Buffer.alloc(0);
  });
  response.on("drain", () => child.stdout.resume());
  child.stdout.on("end", () => {
    if (headersSent && !response.writableEnded) response.end();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorOutput.length < MAX_ERROR_BYTES) errorOutput += chunk.toString("utf8", 0, MAX_ERROR_BYTES - errorOutput.length);
  });
  child.on("error", () => {
    if (!response.headersSent) response.writeHead(502).end();
    else response.destroy();
  });
  child.on("close", (code) => {
    if (!headersSent && !response.writableEnded) {
      response.writeHead(code === 0 ? 502 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(errorOutput.length > 0 ? "Git backend failed\n" : "Git backend produced no response\n");
    }
    finish();
  });
  });
}

function backendEnvironment(
  config: NativeGitServiceConfig,
  identity: NativeGitIdentity,
  route: NativeGitRoute,
  request: IncomingMessage
): NodeJS.ProcessEnv {
  const protocol = request.headers["git-protocol"];
  return {
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: join(config.storageRoot, route.projectId, `${route.repositoryId}.git`, "hooks"),
    GIT_CONFIG_KEY_1: "receive.denyNonFastForwards",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "http.receivepack",
    GIT_CONFIG_VALUE_2: "true",
    HOME: "/dev/null",
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_PROJECT_ROOT: config.storageRoot,
    PATH_INFO: route.pathInfo,
    QUERY_STRING: route.queryString,
    REQUEST_METHOD: request.method ?? "GET",
    CONTENT_LENGTH: request.headers["content-length"] ?? "",
    CONTENT_TYPE: request.headers["content-type"] ?? "",
    REMOTE_ADDR: request.socket.remoteAddress ?? "",
    REMOTE_USER: identity.username,
    DIM_NATIVE_GIT_PROJECT_ID: route.projectId,
    DIM_NATIVE_GIT_REPOSITORY_ID: route.repositoryId,
    ...(identity.role === "writer" ? { DIM_NATIVE_GIT_WORKSPACE_ID: identity.workspaceId } : {}),
    ...(protocol === "version=1" || protocol === "version=2" ? { HTTP_GIT_PROTOCOL: protocol } : {})
  };
}

function writeCgiHeaders(response: ServerResponse, buffer: Buffer): void {
  let status = 200;
  for (const line of buffer.toString("utf8").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10);
    else if (["content-type", "cache-control", "expires", "pragma"].includes(name)) response.setHeader(name, value);
  }
  response.writeHead(Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502);
}
