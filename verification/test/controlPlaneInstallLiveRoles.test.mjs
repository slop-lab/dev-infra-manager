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
const candidateRegistrar = {
  hostId: "candidate-registrar-host",
  username: "candidate-project-registrar",
  password: "candidate-registrar-secret"
};
const candidateGenerationId = "b".repeat(64);
const reviewId = "a".repeat(64);
const projectRoot = "/v1/projects/live-smoke/repositories/root";
const reviewRoot = `${projectRoot}/reviews/${reviewId}`;
const roleNames = ["attempt-issuer", "host", "identity", "query", "registrar", "result-reporter", "webhook"];
const configuredRoleNames = ["query", "identity", "attempt-issuer", "result-reporter", "webhook", "registrar", "host"];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }));
});

describe("control-plane live role denial matrix", () => {
  it("targets current installed routes with explicit per-role outcomes", () => {
    assert.deepEqual(roleDenialCases.map(({ name, method, path, authorizedRoles, availabilityCase, evidence }) => ({
      name, method, path, authorizedRoles,
      ...(availabilityCase === undefined ? {} : { availabilityCase }),
      ...(evidence === undefined ? {} : { evidence })
    })), [
      { name: "admission-register", method: "POST", path: `${projectRoot}/native-root-admission/register`, authorizedRoles: ["registrar"] },
      { name: "admission-discover", method: "POST", path: `${projectRoot}/native-root-admission/discover`, authorizedRoles: ["query"] },
      { name: "event", method: "POST", path: "/v1/native-root-ci-events", authorizedRoles: ["webhook"] },
      { name: "claim", method: "POST", path: "/v1/host-claims", authorizedRoles: ["host"] },
      { name: "claim-result", method: "POST", path: "/v1/host-results", authorizedRoles: ["host"] },
      { name: "admission-identity", method: "GET", path: "/v1/native-root-admission/identity", authorizedRoles: ["query", "registrar"] },
      { name: "host-identity", method: "GET", path: "/v1/host-identity", authorizedRoles: ["host"] },
      { name: "attempt-issue", method: "POST", path: `${reviewRoot}/job-attempts`, authorizedRoles: ["attempt-issuer"] },
      { name: "attempt-revoke", method: "POST", path: `${reviewRoot}/job-attempt-revocations`, authorizedRoles: ["attempt-issuer"] },
      { name: "result-report", method: "POST", path: `${reviewRoot}/statuses`, authorizedRoles: ["result-reporter"] },
      { name: "proof-policy", method: "POST", path: "/v1/projects/live-smoke/repositories/root/native-root-ci-proof/policy", authorizedRoles: ["identity"] },
      { name: "attempt-identity", method: "GET", path: "/v1/native-ordinary-attempt-authority/identity", authorizedRoles: ["attempt-issuer"] },
      { name: "proof-identity", method: "GET", path: "/v1/native-root-ci-proof/identity", authorizedRoles: ["identity"] },
      { name: "human-review-read", method: "GET", path: reviewRoot, authorizedRoles: [] },
      { name: "approval", method: "POST", path: `${reviewRoot}/approvals`, authorizedRoles: [], availabilityCase: "human-review-read" },
      { name: "git-read", method: "GET", path: "/v1/projects/live-smoke/repositories/root.git/info/refs?service=git-upload-pack", authorizedRoles: [], evidence: "generic-activation-gated" },
      { name: "git-write", method: "POST", path: "/v1/projects/live-smoke/repositories/root.git/git-receive-pack", authorizedRoles: [], availabilityCase: "git-read", evidence: "generic-activation-gated" }
    ]);
    for (const testCase of roleDenialCases) {
      assert.deepEqual(Object.keys(testCase.expectedStatuses).sort(), roleNames);
    }
    assert.equal(roleDenialCases.some(({ path }) => path === "/v1/operator-admissions"), false);
  });

  it("checks configured roles plus candidate registrar isolation without printing credentials", async () => {
    const preparations = [];
    const ordinaryPort = await listen(matrixHandler("ordinaryCi", preparations));
    const nativePort = await listen(matrixHandler("nativeGit", preparations));
    const lines = [];
    const captures = { nativeGit: 0, ordinaryCi: 0 };

    await runRoleRequests({
      nativePort,
      ordinaryPort,
      credentials,
      candidateRegistrar,
      candidateGenerationId,
      captureServiceState: async (service) => {
        captures[service] += 1;
        return { rows: 0, sentinel: 1 };
      },
      writeLine: (line) => lines.push(line)
    });

    assert.equal(lines.length, 8);
    assert.match(lines[0], /^authority-denial role=query /);
    for (const [index, line] of lines.slice(0, 7).entries()) {
      const role = configuredRoleNames[index];
      for (const testCase of roleDenialCases) {
        const suffix = testCase.evidence === undefined ? "" : `:${testCase.evidence}`;
        assert.match(line, new RegExp(`${testCase.name}=${testCase.expectedStatuses[role]}${suffix}(?: |$)`));
      }
      for (const secret of Object.values(credentials)) assert.equal(line.includes(secret), false);
    }
    assert.match(lines[7], /^authority-denial role=candidate-project-registrar /);
    assert.match(lines[7], /registrar-identity=200/);
    for (const role of ["query", "identity", "attempt-issuer", "result-reporter", "webhook"]) {
      assert.match(lines[7], new RegExp(`other-${role}=403(?: |$)`));
    }
    for (const role of ["registrar", "host"]) {
      assert.match(lines[7], new RegExp(`other-${role}=401(?: |$)`));
    }
    assert.match(lines[7], /registrar-preparation=503:generic-activation-gated$/);
    assert.equal(lines[7].includes(candidateRegistrar.password), false);
    assert.deepEqual(preparations, [{
      schemaVersion: 1,
      generationId: candidateGenerationId,
      preparation: { serviceId: "native-main", projectId: "live-smoke", rootRepositoryId: "root" }
    }]);
    assert.equal(captures.nativeGit,
      1 + 7 * roleDenialCases.filter(({ service }) => service === "nativeGit").length + 9);
    assert.equal(captures.ordinaryCi, 1 + 7 * roleDenialCases.filter(({ service }) => service === "ordinaryCi").length);
  });

  it("fails at the exact role and route whose service state changes", async () => {
    const ordinaryPort = await listen(matrixHandler("ordinaryCi"));
    const nativePort = await listen(matrixHandler("nativeGit"));
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
    }), /role=query case=admission-register changed ordinaryCi state/);
  });
});

function matrixHandler(service, preparations = []) {
  return (request, response) => {
    const role = roleForAuthorization(request.headers.authorization);
    if (service === "nativeGit" && request.method === "GET"
      && request.url === "/v1/operator-project-registrar-identity") {
      const status = role === "candidate-project-registrar" ? 200
        : ["registrar", "host"].includes(role) ? 401 : 403;
      response.writeHead(status).end();
      return;
    }
    if (service === "nativeGit" && request.method === "POST"
      && request.url === "/v1/operator-project-preparations") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.once("end", () => {
        preparations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(503).end(JSON.stringify({
          error: "native Git business operations require exact generation activation"
        }));
      });
      return;
    }
    const testCase = roleDenialCases.find((candidate) => candidate.service === service
      && candidate.method === request.method && candidate.path === request.url);
    assert.notEqual(role, undefined);
    assert.notEqual(testCase, undefined);
    const body = testCase.evidence === "generic-activation-gated"
      ? JSON.stringify({ error: "native Git business operations require exact generation activation" })
      : "";
    response.writeHead(testCase.expectedStatuses[role]).end(body);
  };
}

function roleForAuthorization(authorization) {
  return [
    ["query", basic("native-query", credentials.query)],
    ["identity", basic("ordinary-identity", credentials.identity)],
    ["attempt-issuer", basic("ordinary-attempts", credentials.attemptIssuer)],
    ["result-reporter", basic("ordinary-results", credentials.resultReporter)],
    ["webhook", basic("native-events", credentials.webhook)],
    ["registrar", basic("ordinary-registrar", credentials.registrar)],
    ["host", basic("host-a", credentials.host)]
    , ["candidate-project-registrar", basic(candidateRegistrar.username, candidateRegistrar.password)]
  ].find(([, expected]) => authorization === expected)?.[0];
}

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
