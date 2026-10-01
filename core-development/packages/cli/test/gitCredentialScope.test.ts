import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitCredentialArguments, matchesGitCredentialScope } from "../../../../core/packages/cli/src/gitCredentialScope.js";
import { runPublishedCli } from "./publishedCliFixture.js";

test("external Git credentials match the configured scheme, authority, and base path", () => {
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "git.example:8443",
    path: "gitea/dim-acme/root.git"
  }, "https://git.example:8443/gitea"), true);
});

test("external Git credentials reject another authority or path", () => {
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "other.example",
    path: "gitea/dim-acme/root.git"
  }, "https://git.example/gitea"), false);
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "git.example",
    path: "unrelated/root.git"
  }, "https://git.example/gitea"), false);
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "git.example",
    path: "gitea/%2e%2e/unrelated/root.git"
  }, "https://git.example/gitea"), false);
});

test("x git delegates credentials to the same URL-scoped helper without secret environment injection", () => {
  assert.deepEqual(gitCredentialArguments(["clone", "http://attacker.invalid/repo"]), [
    "-c", "credential.helper=",
    "-c", "credential.helper=!dim git credential-helper",
    "-c", "credential.useHttpPath=true",
    "clone", "http://attacker.invalid/repo"
  ]);
});

test("x git authenticates a scoped HTTP request through the reviewed credential helper", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-git-credential-helper-"));
  const stateRoot = path.join(root, "state");
  const runtimeRoot = path.join(root, "runtime");
  const configHome = path.join(root, "config");
  const bin = path.join(root, "bin");
  const socketPath = path.join(root, "admin.sock");
  const runtimeDirectory = path.join(
    runtimeRoot,
    "dim",
    createHash("sha256").update(stateRoot).digest("hex").slice(0, 16)
  );
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(configHome, "dim", "config.json"), '{"schemaVersion":1,"workspaceBackend":"sysbox"}\n');
  await writeFile(path.join(runtimeDirectory, "controller.pid"), `${process.pid}\n`);

  const username = "reviewer";
  const password = "fixture-secret";
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  let anonymousRequests = 0;
  let authenticatedRequests = 0;
  const gitServer = createServer((request, response) => {
    if (request.url !== "/managed/root.git/info/refs?service=git-upload-pack") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== expectedAuthorization) {
      anonymousRequests += 1;
      response.writeHead(401, { "www-authenticate": 'Basic realm="DIM test"' }).end();
      return;
    }
    authenticatedRequests += 1;
    response.writeHead(200, {
      "content-type": "application/x-git-upload-pack-advertisement",
      "cache-control": "no-cache"
    }).end("001e# service=git-upload-pack\n00000000");
  });
  gitServer.listen(0, "127.0.0.1");
  await once(gitServer, "listening");
  const address = gitServer.address();
  assert(address !== null && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/managed`;
  let credentialRequests = 0;
  const controller = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/call/git.credentials") {
      credentialRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        username,
        password,
        baseUrl
      }));
      return;
    }
    response.writeHead(404).end();
  });
  controller.listen(socketPath);
  await once(controller, "listening");
  const cliPath = path.resolve(import.meta.dirname, "../../../../core/packages/cli/dist/cli.js");
  const dimWrapper = path.join(bin, "dim");
  await writeFile(dimWrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`);
  await chmod(dimWrapper, 0o700);

  try {
    const result = await runPublishedCli(["x", "git", "ls-remote", `${baseUrl}/root.git`], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DIM_STATE_ROOT: stateRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeRoot,
      DIM_CONTROLLER_SOCKET: socketPath,
      DIM_AGENT_CONTROLLER_SOCKET: socketPath,
      DIM_ADMIN_CONTROLLER_SOCKET: socketPath,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "127.0.0.1"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(credentialRequests, 1);
    assert.equal(anonymousRequests, 1);
    assert.equal(authenticatedRequests, 1);
  } finally {
    gitServer.closeAllConnections();
    gitServer.close();
    controller.closeAllConnections();
    controller.close();
    await Promise.all([once(gitServer, "close"), once(controller, "close")]);
    await rm(root, { recursive: true, force: true });
  }
});
