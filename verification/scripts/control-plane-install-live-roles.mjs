import assert from "node:assert/strict";
import { request } from "node:http";
import {
  assertIdleAuthorityBoundary,
  captureAuthorityBoundaryState,
  captureAuthorityServiceState
} from "./control-plane-install-live-evidence.mjs";

const reviewId = "a".repeat(64);
const projectRoot = "/v1/projects/live-smoke/repositories/root";
const reviewRoot = `${projectRoot}/reviews/${reviewId}`;

export const roleDenialCases = [
  { name: "admission-register", service: "ordinaryCi", method: "POST",
    path: `${projectRoot}/native-root-admission/register`, authorizedRoles: ["registrar"],
    expectedStatuses: ordinaryStatuses("registrar", 503, 404) },
  { name: "admission-discover", service: "ordinaryCi", method: "POST",
    path: `${projectRoot}/native-root-admission/discover`, authorizedRoles: ["query"],
    expectedStatuses: ordinaryStatuses("query", 503) },
  { name: "event", service: "ordinaryCi", method: "POST", path: "/v1/native-root-ci-events",
    authorizedRoles: ["webhook"], expectedStatuses: ordinaryStatuses("webhook", 503) },
  { name: "claim", service: "ordinaryCi", method: "POST", path: "/v1/host-claims",
    authorizedRoles: ["host"], expectedStatuses: ordinaryStatuses("host", 503) },
  { name: "claim-result", service: "ordinaryCi", method: "POST", path: "/v1/host-results",
    authorizedRoles: ["host"], expectedStatuses: ordinaryStatuses("host", 503) },
  { name: "admission-identity", service: "ordinaryCi", method: "GET",
    path: "/v1/native-root-admission/identity", authorizedRoles: ["query", "registrar"],
    expectedStatuses: statuses({ query: 200, registrar: 200 }, 404) },
  { name: "host-identity", service: "ordinaryCi", method: "GET", path: "/v1/host-identity",
    authorizedRoles: ["host"], expectedStatuses: ordinaryStatuses("host", 200) },
  { name: "attempt-issue", service: "nativeGit", method: "POST", path: `${reviewRoot}/job-attempts`,
    authorizedRoles: ["attempt-issuer"], expectedStatuses: nativeStatuses("attempt-issuer", 409) },
  { name: "attempt-revoke", service: "nativeGit", method: "POST",
    path: `${reviewRoot}/job-attempt-revocations`, authorizedRoles: ["attempt-issuer"],
    expectedStatuses: nativeStatuses("attempt-issuer", 409) },
  { name: "result-report", service: "nativeGit", method: "POST", path: `${reviewRoot}/statuses`,
    authorizedRoles: ["result-reporter"], expectedStatuses: nativeStatuses("result-reporter", 409) },
  { name: "proof-policy", service: "nativeGit", method: "POST",
    path: `${projectRoot}/native-root-ci-proof/policy`, authorizedRoles: ["identity"],
    expectedStatuses: nativeStatuses("identity", 400) },
  { name: "attempt-identity", service: "nativeGit", method: "GET",
    path: "/v1/native-ordinary-attempt-authority/identity", authorizedRoles: ["attempt-issuer"],
    expectedStatuses: nativeStatuses("attempt-issuer", 200) },
  { name: "proof-identity", service: "nativeGit", method: "GET", path: "/v1/native-root-ci-proof/identity",
    authorizedRoles: ["identity"], expectedStatuses: nativeStatuses("identity", 200) },
  { name: "human-review-read", service: "nativeGit", method: "GET", path: reviewRoot,
    authorizedRoles: [], expectedStatuses: nativeUnassignedStatuses() },
  { name: "approval", service: "nativeGit", method: "POST", path: `${reviewRoot}/approvals`,
    authorizedRoles: [], expectedStatuses: nativeUnassignedStatuses(), availabilityCase: "human-review-read" },
  { name: "git-read", service: "nativeGit", method: "GET",
    path: `${projectRoot}.git/info/refs?service=git-upload-pack`, authorizedRoles: [],
    expectedStatuses: activationGateStatuses(), evidence: "generic-activation-gated" },
  { name: "git-write", service: "nativeGit", method: "POST", path: `${projectRoot}.git/git-receive-pack`,
    authorizedRoles: [], expectedStatuses: activationGateStatuses(), availabilityCase: "git-read",
    evidence: "generic-activation-gated" }
];

export async function runLiveRoleDenialMatrix(input) {
  const before = await captureAuthorityBoundaryState(input.runner);
  assert.deepEqual(before.projectResources, input.expectedProjectResources);
  assertIdleAuthorityBoundary(before);
  await runRoleRequests({
    nativePort: input.nativePort,
    ordinaryPort: input.ordinaryPort,
    credentials: input.credentials,
    candidateRegistrar: input.candidateRegistrar,
    candidateGenerationId: input.candidateGenerationId,
    captureServiceState: async (service) => captureAuthorityServiceState(input.runner, service),
    writeLine: console.log
  });
  const after = await captureAuthorityBoundaryState(input.runner);
  assert.deepEqual(after, before, "role denial matrix changed runtime, network, volume, socket, or service state");
  console.log(`authority-state native-before=${JSON.stringify(before.services.nativeGit.counts)} native-after=${JSON.stringify(after.services.nativeGit.counts)}`
    + ` ordinary-before=${JSON.stringify(before.services.ordinaryCi.counts)} ordinary-after=${JSON.stringify(after.services.ordinaryCi.counts)}`);
  console.log("authority-boundary runtime=unchanged network=unchanged volumes=unchanged project-resources=unchanged repositories=empty protected-ref=absent sockets=absent");
}

export async function runRoleRequests(input) {
  const baselines = {
    nativeGit: await input.captureServiceState("nativeGit"),
    ordinaryCi: await input.captureServiceState("ordinaryCi")
  };
  for (const role of configuredRoles(input.credentials)) {
    const statuses = [];
    for (const testCase of roleDenialCases) {
      const result = await httpStatus({
        port: testCase.service === "nativeGit" ? input.nativePort : input.ordinaryPort,
        method: testCase.method,
        path: testCase.path,
        authorization: role.authorization
      });
      const expected = testCase.expectedStatuses[role.name];
      const status = result.status;
      assert.equal(status, expected,
        `role=${role.name} case=${testCase.name} returned ${status} activation-gate=${result.activationGate}`);
      if (testCase.evidence === "generic-activation-gated") {
        assert.equal(result.activationGate, true,
          `role=${role.name} case=${testCase.name} did not reach the generic activation gate`);
      }
      const current = await input.captureServiceState(testCase.service);
      assert.deepEqual(current, baselines[testCase.service],
        `role=${role.name} case=${testCase.name} changed ${testCase.service} state`);
      const evidence = testCase.evidence === undefined ? "" : `:${testCase.evidence}`;
      statuses.push(`${testCase.name}=${status}${evidence}`);
    }
    input.writeLine(`authority-denial role=${role.name} ${statuses.join(" ")}`);
  }
  await runCandidateRegistrarRequests(input, baselines.nativeGit);
}

async function httpStatus(input) {
  const bytes = input.body === undefined
    ? input.method === "GET" ? undefined : Buffer.from("{}")
    : Buffer.from(JSON.stringify(input.body));
  return await new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port: input.port,
      method: input.method,
      path: input.path,
      headers: {
        authorization: input.authorization,
        ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": bytes.length })
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        activationGate: Buffer.concat(chunks).toString("utf8").includes("exact generation activation")
      }));
    });
    outgoing.once("error", reject);
    if (bytes !== undefined) outgoing.write(bytes);
    outgoing.end();
  });
}

async function runCandidateRegistrarRequests(input, nativeBaseline) {
  const candidateAuthorization = basic(input.candidateRegistrar.username, input.candidateRegistrar.password);
  const identityStatuses = [];
  const candidateIdentity = await httpStatus({
    port: input.nativePort,
    method: "GET",
    path: "/v1/operator-project-registrar-identity",
    authorization: candidateAuthorization
  });
  assert.equal(candidateIdentity.status, 200, "candidate Project registrar identity was unavailable");
  await assertNativeState("candidate-project-registrar", "registrar-identity");

  for (const role of configuredRoles(input.credentials)) {
    const result = await httpStatus({
      port: input.nativePort,
      method: "GET",
      path: "/v1/operator-project-registrar-identity",
      authorization: role.authorization
    });
    const expected = role.name === "registrar" || role.name === "host" ? 401 : 403;
    assert.equal(result.status, expected,
      `role=${role.name} case=registrar-identity returned ${result.status}`);
    await assertNativeState(role.name, "registrar-identity");
    identityStatuses.push(`other-${role.name}=${result.status}`);
  }

  const preparation = await httpStatus({
    port: input.nativePort,
    method: "POST",
    path: "/v1/operator-project-preparations",
    authorization: candidateAuthorization,
    body: {
      schemaVersion: 1,
      generationId: input.candidateGenerationId,
      preparation: { serviceId: "native-main", projectId: "live-smoke", rootRepositoryId: "root" }
    }
  });
  assert.equal(preparation.status, 503, "preactivation Project preparation was not denied");
  assert.equal(preparation.activationGate, true,
    "preactivation Project preparation did not reach the generic activation gate");
  await assertNativeState("candidate-project-registrar", "registrar-preparation");
  input.writeLine(`authority-denial role=candidate-project-registrar registrar-identity=200 ${identityStatuses.join(" ")}`
    + " registrar-preparation=503:generic-activation-gated");

  async function assertNativeState(role, name) {
    const current = await input.captureServiceState("nativeGit");
    assert.deepEqual(current, nativeBaseline, `role=${role} case=${name} changed nativeGit state`);
  }
}

function configuredRoles(credentials) {
  return [
    ["query", basic("native-query", credentials.query)],
    ["identity", basic("ordinary-identity", credentials.identity)],
    ["attempt-issuer", basic("ordinary-attempts", credentials.attemptIssuer)],
    ["result-reporter", basic("ordinary-results", credentials.resultReporter)],
    ["webhook", basic("native-events", credentials.webhook)],
    ["registrar", basic("ordinary-registrar", credentials.registrar)],
    ["host", basic("host-a", credentials.host)]
  ].map(([name, authorization]) => ({ name, authorization }));
}

function ordinaryStatuses(authorizedRole, authorizedStatus, deniedStatus = 403) {
  return statuses({ [authorizedRole]: authorizedStatus }, deniedStatus);
}

function nativeStatuses(authorizedRole, authorizedStatus) {
  return statuses({ [authorizedRole]: authorizedStatus, registrar: 401, host: 401 }, 403);
}

function nativeUnassignedStatuses() {
  return statuses({ registrar: 401, host: 401 }, 403);
}

function activationGateStatuses() {
  return statuses({}, 503);
}

function statuses(overrides, defaultStatus) {
  return Object.fromEntries([
    "query", "identity", "attempt-issuer", "result-reporter", "webhook", "registrar", "host"
  ].map((role) => [role, overrides[role] ?? defaultStatus]));
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
