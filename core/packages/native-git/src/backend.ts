import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { NativeGitIdentity, NativeGitServiceConfig } from "./config.js";
import type { NativeGitRoute } from "./routing.js";

const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const BACKEND_TIMEOUT_MILLISECONDS = 30_000;

export function serveGitBackend(
  input: GitBackendRequest
): Promise<void> {
  return new Promise((resolve) => {
  const child = spawn(input.config.gitExecutable, ["http-backend"], {
    env: backendEnvironment(input),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let requestBytes = 0;
  let responseBytes = 0;
  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  let errorOutput = "";
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    input.request.resume();
    resolve();
  };
  const fail = (status: number): void => {
    child.kill("SIGKILL");
    if (input.response.writableEnded || input.response.destroyed) return;
    if (!input.response.headersSent) input.response.writeHead(status).end();
    else input.response.destroy();
  };
  const timeout = setTimeout(() => fail(504), BACKEND_TIMEOUT_MILLISECONDS);
  timeout.unref();

  input.request.on("data", (chunk: Buffer) => {
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BYTES) {
      fail(413);
      return;
    }
    if (!child.stdin.destroyed && !child.stdin.write(chunk)) input.request.pause();
  });
  child.stdin.on("drain", () => input.request.resume());
  child.stdin.on("error", () => input.request.resume());
  input.request.on("end", () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
  input.request.on("aborted", () => child.kill("SIGKILL"));
  input.response.on("close", () => {
    if (!input.response.writableEnded) child.kill("SIGKILL");
  });

  child.stdout.on("data", (chunk: Buffer) => {
    if (input.response.writableEnded || input.response.destroyed) return;
    responseBytes += chunk.length;
    if (responseBytes > MAX_RESPONSE_BYTES) {
      fail(502);
      if (input.response.headersSent) input.response.destroy();
      return;
    }
    if (headersSent) {
      if (!input.response.write(chunk)) child.stdout.pause();
      return;
    }
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    if (headerBuffer.length > MAX_HEADER_BYTES) {
      fail(502);
      return;
    }
    const separator = headerBuffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    writeCgiHeaders(input.response, headerBuffer.subarray(0, separator));
    headersSent = true;
    const body = headerBuffer.subarray(separator + 4);
    if (body.length > 0) input.response.write(body);
    headerBuffer = Buffer.alloc(0);
  });
  input.response.on("drain", () => child.stdout.resume());
  child.stdout.on("end", () => {
    if (headersSent && !input.response.writableEnded) input.response.end();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorOutput.length < MAX_ERROR_BYTES) errorOutput += chunk.toString("utf8", 0, MAX_ERROR_BYTES - errorOutput.length);
  });
  child.on("error", () => {
    if (!input.response.headersSent) input.response.writeHead(502).end();
    else input.response.destroy();
  });
  child.on("close", (code) => {
    if (!headersSent && !input.response.writableEnded) {
      input.response.writeHead(code === 0 ? 502 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      input.response.end(errorOutput.length > 0 ? "Git backend failed\n" : "Git backend produced no response\n");
    }
    finish();
  });
  });
}

type GitBackendRequest = {
  readonly config: Pick<NativeGitServiceConfig, "gitExecutable" | "storageRoot">;
  readonly identity: Pick<NativeGitIdentity, "role" | "username"> & { readonly workspaceId?: string };
  readonly route: NativeGitRoute;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
};

function backendEnvironment(input: GitBackendRequest): NodeJS.ProcessEnv {
  const protocol = input.request.headers["git-protocol"];
  return {
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: join(input.config.storageRoot, input.route.projectId, `${input.route.repositoryId}.git`, "hooks"),
    GIT_CONFIG_KEY_1: "receive.denyNonFastForwards",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "http.receivepack",
    GIT_CONFIG_VALUE_2: input.identity.role === "writer" ? "true" : "false",
    GIT_CONFIG_KEY_3: "receive.fsckObjects",
    GIT_CONFIG_VALUE_3: "true",
    GIT_CONFIG_KEY_4: "receive.fsck.fullPathname",
    GIT_CONFIG_VALUE_4: "error",
    GIT_CONFIG_KEY_5: "uploadpack.allowReachableSHA1InWant",
    GIT_CONFIG_VALUE_5: "true",
    HOME: "/dev/null",
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_PROJECT_ROOT: input.config.storageRoot,
    PATH_INFO: input.route.pathInfo,
    QUERY_STRING: input.route.queryString,
    REQUEST_METHOD: input.request.method ?? "GET",
    CONTENT_LENGTH: input.request.headers["content-length"] ?? "",
    CONTENT_TYPE: input.request.headers["content-type"] ?? "",
    REMOTE_ADDR: input.request.socket.remoteAddress ?? "",
    REMOTE_USER: input.identity.username,
    DIM_NATIVE_GIT_PROJECT_ID: input.route.projectId,
    DIM_NATIVE_GIT_REPOSITORY_ID: input.route.repositoryId,
    ...(input.identity.role === "writer" ? { DIM_NATIVE_GIT_WORKSPACE_ID: input.identity.workspaceId } : {}),
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
