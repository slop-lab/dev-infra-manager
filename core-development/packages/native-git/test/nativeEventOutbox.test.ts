import type { Server } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeEventDispatcher,
  createNodeNativeEventHttpClient
} from "../../../../core/packages/native-git/src/native-event-dispatcher.js";
import { createReviewStore } from "../../../../core/packages/native-git/src/review-store.js";
import {
  nativeGitReviewFixture,
  reviewPath,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";
import {
  admission,
  post,
  startAuthority,
  type AuthorityFixture
} from "../../core/test/nativeOrdinaryAuthorityFixture.js";
import {
  authorityDatabaseCounts,
  closeServer,
  createAckLossProxy,
  createCentralFixture,
  reservePort,
  webhookAuthorization
} from "./nativeEventOutboxFixture.js";

const fixtures: ReviewFixture[] = [];
const dispatchers: Array<{ close(): Promise<void> }> = [];
const servers: Server[] = [];
const authorities: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  const completedAuthorities = authorities.splice(0);
  await Promise.all(completedAuthorities.map((authority) => authority.close()));
  await Promise.all(completedAuthorities.map((authority) => authority.remove()));
});

describe("native review-event dispatcher", () => {
  it("converges through real native Git and ordinary authority after losing the first durable ACK", async () => {
    // Given
    let native: ReviewFixture | undefined;
    const authority = await startAuthority({
      nativeGitHttpClient: {
        async request(input) {
          if (native === undefined) throw new Error("native Git fixture is not listening");
          const body: unknown = input.body === undefined ? undefined : JSON.parse(input.body);
          const response = await native.request("ordinary-identity", input.method, input.path, body);
          return {
            statusCode: response.status,
            contentType: response.headers.get("content-type") ?? undefined,
            cacheControl: response.headers.get("cache-control") ?? undefined,
            body: Buffer.from(await response.arrayBuffer())
          };
        }
      }
    });
    authorities.push(authority);
    const proxy = createAckLossProxy(authority.endpoint);
    servers.push(proxy.server);
    const proxyPort = await reservePort(proxy.server);
    await proxy.listen(proxyPort);
    native = await nativeGitReviewFixture(
      undefined,
      createNodeNativeEventHttpClient(`http://127.0.0.1:${proxyPort}`)
    );
    fixtures.push(native);
    const policy = { ...admission("project-a", "source", "1"), requiredJobs: ["security", "source"] } as const;
    expect((await post(authority.endpoint, "/v1/operator-admissions", "registrar", policy)).status).toBe(200);

    // When
    const response = await native.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: native.proposalRef
    });
    await proxy.waitForRequestCount(3);
    await proxy.waitForResponseCount(3);
    expect(proxy.upstreamResponses.map((entry) => entry.slice(0, 3))).toEqual(["202", "202", "202"]);
    await waitForNoPending(native);

    // Then
    expect(response.status).toBe(201);
    expect(proxy.bodies[0]).toBe(proxy.bodies[1]);
    expect(authorityDatabaseCounts(authority.database)).toEqual({ inbox: 2, demands: 2, eventFences: 2, reviewJobFences: 2 });
    const deliveredRoot = `${native.repositoryPath}/dim-reviews/delivered`;
    const markers = await readdir(deliveredRoot);
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(JSON.parse(await readFile(`${deliveredRoot}/${marker}`, "utf8"))).toEqual({
        schemaVersion: 1,
        eventId: marker.slice(0, -5),
        eventDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      });
    }
    await native.restart();
    await expect(createReviewStore(native.repositoryPath).readOutbox(2)).resolves.toEqual([]);
    expect(authorityDatabaseCounts(authority.database)).toEqual({ inbox: 2, demands: 2, eventFences: 2, reviewJobFences: 2 });
  });

  it("keeps review creation available, replays response loss, rejects a false ACK, and resumes only pending events", async () => {
    // Given
    const fixture = await nativeGitReviewFixture();
    fixtures.push(fixture);
    const central = createCentralFixture();
    servers.push(central.server);
    const port = await reservePort(central.server);
    const dispatcher = createNativeEventDispatcher({
      config: fixture.config,
      httpClient: createNodeNativeEventHttpClient(`http://127.0.0.1:${port}`),
      minimumRetryMilliseconds: 10,
      maximumRetryMilliseconds: 30,
      idleMilliseconds: 10
    });
    dispatchers.push(dispatcher);
    dispatcher.start();

    // When
    const review = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: fixture.proposalRef
    });

    // Then
    expect(review.status).toBe(201);
    expect(await createReviewStore(fixture.repositoryPath).readOutbox(2)).toHaveLength(2);

    // When
    central.mode = "lose-first-response";
    await central.listen(port);
    await central.waitForRequestCount(3);

    // Then
    expect(central.requests[0]?.authorization).toBe(webhookAuthorization);
    expect(central.requests[0]?.contentType).toBe("application/json");
    expect(central.requests[0]?.body).toBe(central.requests[1]?.body);
    expect(central.demands.size).toBe(2);
    expect(central.requests.every((request) => !request.body.includes("script") && !request.body.includes("image"))).toBe(true);
    await dispatcher.close();
    dispatchers.splice(dispatchers.indexOf(dispatcher), 1);
    const pendingAfterFalseAck = await createReviewStore(fixture.repositoryPath).readOutbox(2);
    expect(pendingAfterFalseAck).toHaveLength(1);
    const pendingEventId = pendingAfterFalseAck[0]?.event.eventId;

    // When
    await fixture.restart();
    central.mode = "correct";
    const requestsBeforeRestart = central.requests.length;
    const restarted = createNativeEventDispatcher({
      config: fixture.config,
      httpClient: createNodeNativeEventHttpClient(`http://127.0.0.1:${port}`),
      minimumRetryMilliseconds: 10,
      maximumRetryMilliseconds: 30,
      idleMilliseconds: 10
    });
    dispatchers.push(restarted);
    restarted.start();
    await central.waitForRequestCount(requestsBeforeRestart + 1);

    // Then
    expect(JSON.parse(central.requests[requestsBeforeRestart]?.body ?? "{}")).toMatchObject({ eventId: pendingEventId });
    await waitForNoPending(fixture);
    expect(central.demands.size).toBe(2);
    await fixture.restart();
    await expect(createReviewStore(fixture.repositoryPath).readOutbox(2)).resolves.toEqual([]);
  });

  it("aborts an in-flight request and leaves no retry timer after close", async () => {
    // Given
    const fixture = await nativeGitReviewFixture();
    fixtures.push(fixture);
    const central = createCentralFixture();
    central.mode = "hang";
    servers.push(central.server);
    const port = await reservePort(central.server);
    await central.listen(port);
    const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: fixture.proposalRef
    });
    expect(response.status).toBe(201);
    const dispatcher = createNativeEventDispatcher({
      config: fixture.config,
      httpClient: createNodeNativeEventHttpClient(`http://127.0.0.1:${port}`),
      minimumRetryMilliseconds: 10,
      maximumRetryMilliseconds: 30,
      idleMilliseconds: 10,
      requestTimeoutMilliseconds: 20
    });
    dispatcher.start();
    await central.waitForRequestCount(2);

    // When
    await dispatcher.close();

    // Then
    await expect(createReviewStore(fixture.repositoryPath).readOutbox(2)).resolves.toHaveLength(2);
  });

  it.each(["wrong-id", "cacheable", "redirect"] as const)(
    "keeps an event pending after a %s acknowledgement",
    async (mode) => {
      // Given
      const fixture = await nativeGitReviewFixture();
      fixtures.push(fixture);
      const central = createCentralFixture();
      central.mode = mode;
      servers.push(central.server);
      const port = await reservePort(central.server);
      await central.listen(port);
      const review = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
        protectedRef: "refs/heads/main",
        proposalRef: fixture.proposalRef
      });
      expect(review.status).toBe(201);
      const dispatcher = createNativeEventDispatcher({
        config: fixture.config,
        httpClient: createNodeNativeEventHttpClient(`http://127.0.0.1:${port}`),
        minimumRetryMilliseconds: 30,
        maximumRetryMilliseconds: 30,
        idleMilliseconds: 10
      });
      dispatcher.start();
      await central.waitForRequestCount(1);

      // When
      await dispatcher.close();

      // Then
      await expect(createReviewStore(fixture.repositoryPath).readOutbox(2)).resolves.toHaveLength(2);
    }
  );
});

async function waitForNoPending(fixture: ReviewFixture): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await createReviewStore(fixture.repositoryPath).readOutbox(2)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("dispatcher did not acknowledge the pending event");
}
