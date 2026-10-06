import assert from "node:assert/strict";
import { request } from "node:http";
import {
  assertIdleAuthorityBoundary,
  captureAuthorityBoundaryState,
  captureAuthorityServiceState
} from "./control-plane-install-live-evidence.mjs";

const reviewId = "a".repeat(64);
const reviewRoot = `/v1/projects/live-smoke/repositories/root/reviews/${reviewId}`;

export const roleDenialCases = [
  mutation("admission", "ordinaryCi", "/v1/operator-admissions"),
  mutation("event", "ordinaryCi", "/v1/native-events"),
  mutation("capacity-advertisement", "ordinaryCi", "/v1/operator-admissions"),
  mutation("claim", "ordinaryCi", "/v1/host-claims"),
  mutation("claim-result", "ordinaryCi", "/v1/host-results"),
  mutation("attempt-issue", "nativeGit", `${reviewRoot}/job-attempts`),
  mutation("attempt-revoke", "nativeGit", `${reviewRoot}/job-attempt-revocations`),
  mutation("result-report", "nativeGit", `${reviewRoot}/statuses`),
  mutation("review", "nativeGit", "/v1/projects/live-smoke/repositories/root/reviews"),
  mutation("approval", "nativeGit", `${reviewRoot}/approvals`),
  mutation("promotion", "nativeGit", `${reviewRoot}/promotions`),
  mutation("git-write", "nativeGit", "/v1/projects/live-smoke/repositories/root.git/git-receive-pack"),
  { name: "identity-read", service: "ordinaryCi", method: "GET", path: "/v1/identity", expectedStatus: 404, queryStatus: 200 },
  { name: "admission-read", service: "ordinaryCi", method: "GET", path: "/v1/admission-verifications", expectedStatus: 404 },
  { name: "ordinary-admin-read", service: "ordinaryCi", method: "GET", path: "/v1/admin", expectedStatus: 404 },
  {
    name: "git-read", service: "nativeGit", method: "GET",
    path: "/v1/projects/live-smoke/repositories/root.git/info/refs?service=git-upload-pack", expectedStatus: 404
  },
  { name: "native-admin-read", service: "nativeGit", method: "GET", path: "/v1/admin", expectedStatus: 404 }
];

export async function runLiveRoleDenialMatrix(input) {
  const before = await captureAuthorityBoundaryState(input.runner);
  assert.deepEqual(before.projectResources, input.expectedProjectResources);
  assertIdleAuthorityBoundary(before);
  await runRoleRequests({
    nativePort: input.nativePort,
    ordinaryPort: input.ordinaryPort,
    credentials: input.credentials,
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
      const status = await httpStatus({
        port: testCase.service === "nativeGit" ? input.nativePort : input.ordinaryPort,
        method: testCase.method,
        path: testCase.path,
        authorization: role.authorization
      });
      const expected = role.name === "query" && testCase.queryStatus !== undefined
        ? testCase.queryStatus
        : testCase.expectedStatus;
      assert.equal(status, expected, `role=${role.name} case=${testCase.name} returned ${status}`);
      const current = await input.captureServiceState(testCase.service);
      assert.deepEqual(current, baselines[testCase.service],
        `role=${role.name} case=${testCase.name} changed ${testCase.service} state`);
      statuses.push(`${testCase.name}=${status}`);
    }
    input.writeLine(`authority-denial role=${role.name} ${statuses.join(" ")}`);
  }
}

async function httpStatus(input) {
  const bytes = input.method === "GET" ? undefined : Buffer.from("{}");
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
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    if (bytes !== undefined) outgoing.write(bytes);
    outgoing.end();
  });
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

function mutation(name, service, path) {
  return { name, service, method: "POST", path, expectedStatus: 503 };
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
