import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthoritativeNativeEventDispatcher } from "../../../../core/packages/native-git/src/authoritative-native-event-dispatcher.js";
import { createAuthoritativeNativeQemuEventDispatcher } from "../../../../core/packages/native-git/src/authoritative-native-qemu-event-dispatcher.js";
import { AuthoritativeNativeReviewAdmissionBusyError } from "../../../../core/packages/native-git/src/authoritative-native-review-controller.js";
import { initializeNativeGitBundleState } from "../../../../core/packages/native-git/src/native-bundle-state.js";

describe("native event dispatcher admission", () => {
  it.each(["ordinary", "qemu"] as const)("retries %s capacity saturation without poisoning health", async (lane) => {
    await admissionScenario(lane, "busy");
  });

  it.each(["ordinary", "qemu"] as const)("still fails closed on %s non-transient errors", async (lane) => {
    await admissionScenario(lane, "fatal");
  });
});

async function admissionScenario(lane: "ordinary" | "qemu", scenario: "busy" | "fatal"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dim-dispatcher-admission-"));
  const state = await initializeNativeGitBundleState(root);
  let running = false;
  let attempts = 0;
  const error = scenario === "busy"
    ? new AuthoritativeNativeReviewAdmissionBusyError("shared operation capacity is busy")
    : new Error("unexpected storage integrity failure");
  const common = {
    state, stateDirectory: root,
    minimumRetryMilliseconds: 1, maximumRetryMilliseconds: 1,
    async serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
      if (running) {
        attempts += 1;
        if (attempts === 1) throw error;
      }
      return operation();
    },
    httpClient: { async request(): Promise<never> { throw new Error("idle dispatcher must not send HTTP"); } }
  };
  const credential = { username: "unused", password: "unused" };
  const dispatcher = lane === "ordinary"
    ? await createAuthoritativeNativeEventDispatcher({ ...common,
      generationId: "a".repeat(64), webhook: { ...credential, endpoint: "http://127.0.0.1:1" } })
    : await createAuthoritativeNativeQemuEventDispatcher({ ...common,
      dependency: { endpoint: "http://127.0.0.1:1", serviceId: "qemu-main",
        query: credential, identity: credential, attemptIssuer: credential,
        candidateReader: credential, resultReporter: credential, eventIntake: credential } });
  try {
    running = true;
    dispatcher.start();
    if (scenario === "busy") {
      await expect.poll(() => attempts, { timeout: 3_000 }).toBe(2);
      expect(dispatcher.healthy()).toBe(true);
      await dispatcher.close();
    } else {
      await expect.poll(() => dispatcher.healthy(), { timeout: 3_000 }).toBe(false);
      await expect(dispatcher.close()).rejects.toBe(error);
      expect(attempts).toBe(1);
    }
  } finally {
    await dispatcher.close().catch(() => undefined);
    await state.owner.release();
    await rm(root, { recursive: true, force: true });
  }
}
