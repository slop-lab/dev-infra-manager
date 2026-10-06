import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "vitest";
import { roleDenialCases, runRoleRequests } from "../scripts/control-plane-install-live-roles.mjs";

const servers = [];
const credentials = {
  query: "query-secret",
  identity: "identity-secret",
  attemptIssuer: "issuer-secret",
  resultReporter: "reporter-secret",
  webhook: "webhook-secret",
  registrar: "registrar-secret",
  host: "host-secret"
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }));
});

describe("control-plane live role denial matrix", () => {
  it("checks every configured role against every idle route class without printing credentials", async () => {
    const queryAuthorization = basic("native-query", credentials.query);
    const ordinaryPort = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://ordinary-ci");
      const status = request.method === "GET" && url.pathname === "/v1/identity"
        ? request.headers.authorization === queryAuthorization ? 200 : 404
        : isMutation(request.method) ? 503 : 404;
      response.writeHead(status).end();
    });
    const nativePort = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://native-git");
      const status = url.search !== "" ? 404
        : isMutation(request.method) || url.pathname.startsWith("/v1/projects/") || url.pathname.includes(".git/")
          ? 503
          : 404;
      response.writeHead(status).end();
    });
    const lines = [];
    const captures = { nativeGit: 0, ordinaryCi: 0 };

    await runRoleRequests({
      nativePort,
      ordinaryPort,
      credentials,
      captureServiceState: async (service) => {
        captures[service] += 1;
        return { rows: 0, sentinel: 1 };
      },
      writeLine: (line) => lines.push(line)
    });

    assert.equal(lines.length, 7);
    assert.match(lines[0], /^authority-denial role=query /);
    assert.match(lines[0], /identity-read=200/);
    for (const line of lines.slice(1)) assert.match(line, /identity-read=404/);
    for (const line of lines) {
      for (const testCase of roleDenialCases.filter(({ expectedStatus }) => expectedStatus === 503)) {
        assert.match(line, new RegExp(`${testCase.name}=503(?: |$)`));
      }
      for (const secret of Object.values(credentials)) assert.equal(line.includes(secret), false);
    }
    assert.equal(captures.nativeGit, 1 + 7 * roleDenialCases.filter(({ service }) => service === "nativeGit").length);
    assert.equal(captures.ordinaryCi, 1 + 7 * roleDenialCases.filter(({ service }) => service === "ordinaryCi").length);
  });

  it("fails at the exact role and route whose service state changes", async () => {
    const ordinaryPort = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://ordinary-ci");
      const status = request.method === "GET" && url.pathname === "/v1/identity" ? 200
        : isMutation(request.method) ? 503 : 404;
      response.writeHead(status).end();
    });
    const nativePort = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://native-git");
      response.writeHead(url.search !== "" ? 404 : isMutation(request.method) ? 503 : 404).end();
    });
    let ordinaryCaptures = 0;

    await assert.rejects(runRoleRequests({
      nativePort,
      ordinaryPort,
      credentials,
      captureServiceState: async (service) => {
        if (service === "ordinaryCi") ordinaryCaptures += 1;
        return { rows: service === "ordinaryCi" && ordinaryCaptures > 1 ? 1 : 0 };
      },
      writeLine: () => {}
    }), /role=query case=admission changed ordinaryCi state/);
  });
});

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("test server has no TCP address");
  return address.port;
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function isMutation(method) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
