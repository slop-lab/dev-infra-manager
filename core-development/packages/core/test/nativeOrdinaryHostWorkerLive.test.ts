import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { createNativeOrdinaryHostClient, type NativeOrdinaryHostClient } from "../../../../core/packages/core/src/nativeOrdinaryHostClient.js";
import { serveNativeOrdinaryHostCapacity } from "../../../../core/packages/core/src/nativeOrdinaryHostWorker.js";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import { createNodeAdmissionVerifierHttpClient, createOrdinaryAdmissionVerifier } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { nativeGitReviewFixture, readJsonObject, reviewPath, stringField, type ReviewFixture } from "../../native-git/test/nativeGitReviewHarness.js";
import { authorityCredentials, authorityHostCredentials, jsonRecord, post, startAuthority, type AuthorityFixture } from "./nativeOrdinaryAuthorityFixture.js";
import { ExecutorRunner } from "./nativeOrdinaryExecutorFixture.js";
import { centralState, completed, demandStates, waitFor } from "./nativeOrdinaryHostWorkerLiveFixture.js";

const authorities: AuthorityFixture[] = [];
const natives: ReviewFixture[] = [];
const journalRoots: string[] = [];

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
  await Promise.all(natives.splice(0).map((fixture) => fixture.close()));
  await Promise.all(journalRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary host capacity worker live integration", () => {
  it("replays durable claim, result, and recovery bytes across lost replies and worker restarts", async () => {
    // Given
    const attemptPassword = "attempt-credential-secret-000000000000";
    const reporterPassword = "reporter-credential-secret-00000000000";
    let authorityEndpoint = "";
    let nativeEndpoint = "";
    const nativeTransport = createNodeNativeGitAdmissionHttpClient();
    const central = await startAuthority({
      nativeGitHttpClient: {
        request: (input) => nativeTransport.request({ ...input, endpoint: nativeEndpoint })
      },
      nativeGitAttemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
      nativeGitResultReporter: { username: "ordinary-results", password: reporterPassword },
      useConfiguredResultReporter: true
    });
    authorities.push(central);
    authorityEndpoint = central.endpoint;
    const verifierTransport = createNodeAdmissionVerifierHttpClient();
    const verifier = await createOrdinaryAdmissionVerifier({
      config: {
        endpoint: "http://ordinary-ci:8080",
        serviceId: "ordinary-main",
        query: authorityCredentials.query,
        identity: { username: "ordinary-identity", password: "identity-secret-00000000000000000000" },
        attemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
        resultReporter: { username: "ordinary-results", password: reporterPassword },
        webhook: {
          endpoint: "http://ordinary-ci:8080/v1/native-events",
          username: authorityCredentials.webhook.username,
          password: authorityCredentials.webhook.password
        }
      },
      httpClient: {
        request: (input) => verifierTransport.request({ ...input, endpoint: authorityEndpoint })
      }
    });
    const native = await nativeGitReviewFixture(verifier);
    natives.push(native);
    const ordinaryCi = native.config.ordinaryCi;
    if (ordinaryCi === undefined) throw new Error("ordinary CI config is missing");
    await native.restart({
      ...native.config,
      ordinaryCi: {
        ...ordinaryCi,
        attemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
        resultReporter: { username: "ordinary-results", password: reporterPassword }
      }
    });
    nativeEndpoint = native.baseUrl();
    await native.git(native.clone, [
      "remote", "set-url", "origin",
      `${native.baseUrl().replace("://", "://writer-a:writer-a-secret-1@")}/v1/projects/project-a/repositories/source.git`
    ]);
    await native.git(native.clone, ["rm", "documentation"]);
    await native.git(native.clone, ["commit", "-m", "remove unsupported symlink"]);
    await native.git(native.clone, ["push", "--force", "origin", `HEAD:${native.proposalRef}`]);
    const reviewResponse = await native.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: native.proposalRef
    });
    const reviewId = stringField(await readJsonObject(reviewResponse), "reviewId");
    const proposal = parseReviewEnvelope(JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`), "utf8"
    )));
    const event = proposal.events.find((candidate) => candidate.jobName === "source");
    if (event === undefined) throw new Error("source event is missing");
    const recoveryEvent = proposal.events.find((candidate) => candidate.jobName === "security");
    if (recoveryEvent === undefined) throw new Error("security event is missing");
    const admission = await post(central.endpoint, "/v1/operator-admissions", "registrar", {
      schemaVersion: 1,
      projectId: "project-a",
      repositoryId: "source",
      protectedRef: "refs/heads/main",
      policyRevision: "policy-1",
      requiredReviewRevision: "review-1",
      requiredJobSetRevision: "jobs-1",
      requiredJobs: ["security", "source"]
    });
    if (admission.status !== 200) throw new Error(await admission.text());
    const generation = (await jsonRecord(admission)).admissionGeneration;
    if (typeof generation !== "string") throw new Error("admission generation is missing");
    native.setAdmissionGeneration(generation);
    expect((await post(central.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
    const hostConfig = {
      endpoint: central.endpoint,
      serviceId: "ordinary-main",
      hostId: "host-a",
      capacity: "primary",
      credential: authorityHostCredentials["host-a"]
    } as const;
    const hostTransport = createNodeNativeGitAdmissionHttpClient();
    const requests: Array<{ readonly path: string; readonly body: string | undefined; readonly status: number }> = [];
    let lostClaim = true;
    let lostResults = 3;
    let lostEmptyClaim = true;
    let lostRecovery = true;
    let stopAfterEmpty: AbortController | undefined;
    const httpClient = {
      async request(input: Parameters<typeof hostTransport.request>[0]) {
        const response = await hostTransport.request(input);
        requests.push({ path: input.path, body: input.body, status: response.statusCode });
        if (input.path === "/v1/host-claims" && response.statusCode === 200 && lostClaim) {
          lostClaim = false;
          throw new Error("simulated lost claim response");
        }
        if (input.path === "/v1/host-results" && response.statusCode === 202 && lostResults > 0) {
          lostResults -= 1;
          throw new Error("simulated lost result response");
        }
        if (input.path === "/v1/host-claims" && response.statusCode === 204 && lostEmptyClaim) {
          lostEmptyClaim = false;
          throw new Error("simulated lost empty claim response");
        }
        if (input.path === "/v1/host-recoveries" && response.statusCode === 204 && lostRecovery) {
          lostRecovery = false;
          throw new Error("simulated lost recovery response");
        }
        if (input.path === "/v1/host-claims" && response.statusCode === 204) stopAfterEmpty?.abort();
        return response;
      }
    };
    const client = (): NativeOrdinaryHostClient => createNativeOrdinaryHostClient(hostConfig, httpClient);
    const runner = new ExecutorRunner();
    const journalRoot = await mkdtemp(join(tmpdir(), "dim-native-worker-live-"));
    journalRoots.push(journalRoot);
    const journalPath = join(journalRoot, "primary.json");
    const worker = (workerClient: NativeOrdinaryHostClient, signal: AbortSignal) => serveNativeOrdinaryHostCapacity({
      client: workerClient,
      runner,
      gitExecutable: native.config.gitExecutable,
      nativeGitEndpoint: native.baseUrl(),
      journalPath,
      async resolveReaderCredential(scope) {
        return {
          ...scope,
          username: "ci-a",
          password: "ci-a-secret-value"
        };
      }
    }, signal);

    // When
    await expect(worker(client(), new AbortController().signal)).rejects.toThrow("host request failed");
    const claimJournal = await readFile(journalPath, "utf8");
    await expect(worker(client(), new AbortController().signal)).rejects.toThrow("acknowledgement is uncertain");
    const resultJournal = await readFile(journalPath, "utf8");
    await waitFor(() => completed(central.database));
    await expect(worker(client(), new AbortController().signal)).rejects.toThrow("host request failed");
    const emptyClaimJournal = await readFile(journalPath, "utf8");
    const emptyController = new AbortController();
    stopAfterEmpty = emptyController;
    await worker(client(), emptyController.signal);
    stopAfterEmpty = undefined;
    expect((await post(central.endpoint, "/v1/native-events", "webhook", recoveryEvent)).status).toBe(202);
    const recoveryClient = client();
    const recoveryRunner = new ExecutorRunner();
    await expect(serveNativeOrdinaryHostCapacity({
      client: recoveryClient,
      runner: recoveryRunner,
      gitExecutable: native.config.gitExecutable,
      nativeGitEndpoint: native.baseUrl(),
      journalPath,
      resolveReaderCredential: async () => undefined
    }, new AbortController().signal)).rejects.toThrow(/recovery/);
    const recoveryJournal = await readFile(journalPath, "utf8");
    const recoveredController = new AbortController();
    stopAfterEmpty = recoveredController;
    await serveNativeOrdinaryHostCapacity({
      client: client(),
      runner: recoveryRunner,
      gitExecutable: native.config.gitExecutable,
      nativeGitEndpoint: native.baseUrl(),
      journalPath,
      resolveReaderCredential: async () => undefined
    }, recoveredController.signal);
    const status = JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "statuses", reviewId, "source", "1.json"), "utf8"
    ));
    const claimRequests = requests.filter((request) => request.path === "/v1/host-claims");
    const resultRequests = requests.filter((request) => request.path === "/v1/host-results");
    const recoveryRequests = requests.filter((request) => request.path === "/v1/host-recoveries");
    const emptyClaims = claimRequests.filter((request) => request.status === 204);

    // Then
    expect(status.payload.result).toBe("success");
    expect(status.reporterUsername).toBe("ordinary-results");
    expect(JSON.parse(claimJournal).kind).toBe("claim");
    expect(JSON.parse(resultJournal).kind).toBe("result");
    expect(JSON.parse(emptyClaimJournal).kind).toBe("claim");
    expect(JSON.parse(recoveryJournal).kind).toBe("recovery");
    expect([claimJournal, resultJournal, emptyClaimJournal, recoveryJournal].join(""))
      .not.toMatch(/host-a-token|ci-a-secret|attempt-credential|reporter-credential/);
    expect(claimRequests[1]?.body).toBe(claimRequests[0]?.body);
    expect(emptyClaims[1]?.body).toBe(emptyClaims[0]?.body);
    expect(new Set(resultRequests.map((request) => request.body)).size).toBe(1);
    expect(resultRequests).toHaveLength(4);
    expect(recoveryRequests).toHaveLength(2);
    expect(recoveryRequests[1]?.body).toBe(recoveryRequests[0]?.body);
    expect(runner.calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
    expect(recoveryRunner.calls.some((call) => call.args[0] === "run")).toBe(false);
    expect(runner.calls.some((call) => call.args.slice(0, 3).join(" ") === "container rm --force")).toBe(true);
    expect(JSON.stringify(runner.calls)).not.toMatch(/host-a-token|ci-a-secret/);
    expect(demandStates(central.database)).toEqual(["completed", "superseded"]);
    expect(centralState(central.database)).toEqual({
      results: 1,
      outbox: ["delivered"],
      claims: ["released", "released"],
      activeReceipts: 0,
      fences: 0
    });
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
