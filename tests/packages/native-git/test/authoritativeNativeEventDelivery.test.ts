import { createHash } from "node:crypto";
import { chmod, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import {
  authorization,
  post,
  receiptRows,
  startDeliveryScenario,
  waitFor,
  type DeliveryScenario
} from "./authoritativeNativeEventDeliveryFixture.js";
import { addCandidateCommit, createBundleReview, reviewProposalRef } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

const scenarios: DeliveryScenario[] = [];
afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.close()));
  await cleanupFinalizeFixtures();
});

describe("installed authoritative native event delivery", () => {
  it("does not accept a new listener after storage ownership is released", async () => {
    // Given
    const scenario = await scenarioFor("closed-listener");
    const service = scenario.native.service;
    const first = service.close();
    const second = service.close();
    await first;

    // When
    const rejected = service.listen("127.0.0.1", 0);

    // Then
    expect(second).toBe(first);
    await expect(rejected).rejects.toThrow(/closed/);
    const terminated = new Promise<void>((resolve) => service.server.once("close", resolve));
    service.server.listen(0, "127.0.0.1");
    await terminated;
    expect(service.server.listening).toBe(false);
  });

  it("publishes one ordinary receipt and never submits or accepts the QEMU event", async () => {
    // Given
    const scenario = await scenarioFor("ordinary-only");

    // When
    const envelope = await createBundleReview(scenario.native.service);
    await waitFor(() => receiptRows(scenario.ordinaryDatabase).length === 1);
    await waitFor(async () => (await deliveredMarkers(scenario)).length === 1);
    const qemu = envelope.events.find(({ executionKind }) => executionKind === "qemu");
    if (qemu === undefined) throw new TypeError("QEMU event is missing");
    const qemuResponse = await post(scenario.ordinaryOrigin, "/v1/native-root-ci-events",
      authorization("native-events", bundleSecrets.webhook), { schemaVersion: 1, generationId,
        admissionGeneration: scenario.admissionGeneration, event: qemu });

    // Then
    expect(qemuResponse.status).toBe(400);
    expect(scenario.bridge.receiptBodies.map((body) => JSON.parse(body).event.executionKind))
      .toEqual(["ordinary-sysbox"]);
    expect(receiptRows(scenario.ordinaryDatabase)).toHaveLength(1);
    expect(await deliveredMarkers(scenario)).toHaveLength(1);
  });

  it("redelivers identical bytes after lost acknowledgement and native restart without a duplicate receipt", async () => {
    // Given
    const scenario = await scenarioFor("lost-ack-restart");
    scenario.bridge.loseNextReceiptAcknowledgement = true;
    const envelope = await createBundleReview(scenario.native.service);
    const ordinary = envelope.events.find(({ executionKind }) => executionKind === "ordinary-sysbox");
    if (ordinary === undefined) throw new TypeError("ordinary event is missing");
    await scenario.bridge.lostAcknowledgement;
    await closeFinalizeService(scenario.native.service);
    expect(receiptRows(scenario.ordinaryDatabase)).toHaveLength(1);
    expect(await deliveredMarkers(scenario)).toEqual([]);

    // When
    const restarted = await startFinalizeService(scenario.native.root, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, scenario.bridge);
    await waitFor(async () => (await deliveredMarkers(scenario)).length === 1);

    // Then
    expect(restarted.server.listening).toBe(true);
    expect(scenario.bridge.receiptBodies).toHaveLength(2);
    expect(scenario.bridge.receiptBodies[1]).toBe(scenario.bridge.receiptBodies[0]);
    expect(receiptRows(scenario.ordinaryDatabase)).toEqual([expect.objectContaining({
      admission_generation: scenario.admissionGeneration, event_id: ordinary.eventId
    })]);
    const marker = JSON.parse(await readFile((await deliveredMarkers(scenario))[0] ?? "", "utf8"));
    expect(marker).toEqual({ schemaVersion: 1, eventId: ordinary.eventId,
      eventDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      admissionGeneration: scenario.admissionGeneration });
  });

  it("retries a transient marker publication error after ordinary committed the receipt", async () => {
    // Given
    const scenario = await scenarioFor("marker-write-retry");
    scenario.bridge.failNextMarkerWrite = true;

    // When
    const envelope = await createBundleReview(scenario.native.service);
    const event = envelope.events.find(({ executionKind }) => executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary event is missing");
    await waitFor(() => scenario.bridge.markerFailures === 1);
    await waitFor(async () => (await deliveredMarkers(scenario)).length === 1);

    // Then
    expect(scenario.bridge.receiptBodies).toHaveLength(2);
    expect(scenario.bridge.receiptBodies[1]).toBe(scenario.bridge.receiptBodies[0]);
    expect(receiptRows(scenario.ordinaryDatabase)).toEqual([expect.objectContaining({ event_id: event.eventId })]);
  });

  it("marks the native service unready when delivery marker integrity fails", async () => {
    // Given
    const scenario = await scenarioFor("fatal-marker");
    const readiness = () => fetch(`${scenario.native.service.origin}/readyz`, { headers: {
      authorization: `Bearer ${Buffer.alloc(32, 41).toString("base64url")}`
    } });
    expect((await readiness()).status).toBe(200);
    scenario.bridge.failMarkerIntegrity = true;

    // When
    await createBundleReview(scenario.native.service);
    await waitFor(() => scenario.bridge.markerFailures === 1);
    await waitFor(async () => (await readiness()).status === 503);

    // Then
    expect(receiptRows(scenario.ordinaryDatabase)).toHaveLength(1);
    expect(await deliveredMarkers(scenario)).toEqual([]);
    await expect(closeFinalizeService(scenario.native.service)).rejects.toThrow(/marker integrity/);
  });

  it("keeps the event pending while admission discovery is unavailable or stale", async () => {
    // Given
    const scenario = await scenarioFor("pending-admission");
    scenario.bridge.mode = "unavailable";
    await createBundleReview(scenario.native.service);
    await waitFor(() => scenario.bridge.requests.some(({ path }) => path.endsWith("/discover")));

    // When / Then
    expect(receiptRows(scenario.ordinaryDatabase)).toEqual([]);
    expect(await deliveredMarkers(scenario)).toEqual([]);
    scenario.bridge.mode = "stale";
    const attempts = scenario.bridge.requests.length;
    await waitFor(() => scenario.bridge.requests.length > attempts);
    expect(receiptRows(scenario.ordinaryDatabase)).toEqual([]);
    expect(await deliveredMarkers(scenario)).toEqual([]);
    scenario.bridge.mode = "normal";
    await waitFor(() => receiptRows(scenario.ordinaryDatabase).length === 1);
    await waitFor(async () => (await deliveredMarkers(scenario)).length === 1);
  });

  it("selects the oldest authoritative ordinary review before lexical event IDs", async () => {
    // Given
    const scenario = await scenarioFor("oldest-event");
    scenario.bridge.mode = "unavailable";
    const first = await createBundleReview(scenario.native.service);
    await addCandidateCommit(scenario.native.clone, "second.txt", Buffer.from("second\n"));
    await runGit("/usr/bin/git", ["-C", scenario.native.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const second = await createBundleReview(scenario.native.service);
    const ordinary = (envelope: typeof first) => envelope.events.find(({ executionKind }) => executionKind === "ordinary-sysbox");
    const older = ordinary(first)?.eventId.localeCompare(ordinary(second)?.eventId ?? "") === 1 ? first : second;
    const newer = older === first ? second : first;
    const oldEvent = ordinary(older);
    if (oldEvent === undefined) throw new TypeError("older ordinary event is missing");
    await closeFinalizeService(scenario.native.service);
    const reviewPath = (reviewId: string) => join(scenario.native.root, "project-a", "root.git",
      "dim-authoritative-reviews", "proposals", `${reviewId}.json`);
    await writeFile(reviewPath(older.review.reviewId), `${JSON.stringify({ ...older,
      review: { ...older.review, createdAt: "2025-01-01T00:00:00.000Z" } })}\n`);
    await writeFile(reviewPath(newer.review.reviewId), `${JSON.stringify({ ...newer,
      review: { ...newer.review, createdAt: "2026-01-01T00:00:00.000Z" } })}\n`);

    // When
    scenario.bridge.mode = "normal";
    await startFinalizeService(scenario.native.root, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, scenario.bridge);
    await waitFor(() => scenario.bridge.receiptBodies.length > 0);

    // Then
    expect(JSON.parse(scenario.bridge.receiptBodies[0] ?? "{}").event.eventId).toBe(oldEvent.eventId);
  });

  it.each(["foreign-staging", "foreign-tombstone", "unsafe-tombstone"] as const)(
    "fails closed on %s state without rewriting it",
    async (kind) => {
      // Given
      const scenario = await scenarioFor(`integrity-${kind}`);
      scenario.bridge.mode = "unavailable";
      const envelope = await createBundleReview(scenario.native.service);
      const event = envelope.events.find(({ executionKind }) => executionKind === "ordinary-sysbox");
      if (event === undefined) throw new TypeError("ordinary event is missing");
      await waitFor(() => scenario.bridge.requests.some(({ path }) => path.endsWith("/discover")));
      await closeFinalizeService(scenario.native.service);
      const root = join(scenario.native.root, "project-a", "root.git", "dim-authoritative-reviews");
      const path = kind === "foreign-staging" ? join(root, "delivery-staging", "foreign.tmp")
        : join(root, "delivered", kind === "foreign-tombstone" ? "foreign.json" : `${event.eventId}.json`);
      const marker = { schemaVersion: 1, eventId: event.eventId,
        eventDigest: `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`,
        admissionGeneration: scenario.admissionGeneration };
      await writeFile(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      if (kind === "unsafe-tombstone") await chmod(path, 0o640);
      const original = await readFile(path);

      // When / Then
      await expect(startFinalizeService(scenario.native.root, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, scenario.bridge)).rejects.toThrow();
      expect(await readFile(path)).toEqual(original);
      await unlink(path);
      const recovered = await startFinalizeService(scenario.native.root, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, scenario.bridge);
      expect(recovered.server.listening).toBe(true);
    }
  );
});

async function scenarioFor(label: string): Promise<DeliveryScenario> {
  const scenario = await startDeliveryScenario(label);
  scenarios.push(scenario);
  return scenario;
}
async function deliveredMarkers(scenario: DeliveryScenario): Promise<readonly string[]> {
  const directory = join(scenario.native.root, "project-a", "root.git", "dim-authoritative-reviews", "delivered");
  try { return (await readdir(directory)).map((name) => join(directory, name)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
