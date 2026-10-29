import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCiDeliveryDispatcher } from "../../../packages/gs/ci/src/delivery-dispatcher.js";
import { jsonCiDeliveryEventCodec } from "../../../packages/gs/ci/src/authoritative-native-delivery-binding.js";
import { initializeDeliveryIntentStore } from "../../../packages/gs/ci/src/authoritative-native-delivery-intent-store.js";

it("owns a corrupt pending-store failure through explicit stop and observed close", async () => {
  const repository = await mkdtemp(join(tmpdir(), "gs-ci-dispatcher-failure-"));
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", recordUnhandled);
  try {
    let repositoryReads = 0;
    let scanStarted: (() => void) | undefined;
    const scanning = new Promise<void>((resolve) => { scanStarted = resolve; });
    const dispatcher = await createCiDeliveryDispatcher({
      serviceId: "portable",
      destination: "portable://execution",
      eventCodec: jsonCiDeliveryEventCodec,
      generationId: "a".repeat(64),
      repositories: () => {
        repositoryReads += 1;
        if (repositoryReads > 2) scanStarted?.();
        return [repository];
      },
      serialize: (operation) => operation(),
      submit: { async submit() { throw new Error("submit must not run"); } },
      idleMilliseconds: 30_000,
    });
    const paths = await initializeDeliveryIntentStore(repository);
    await writeFile(join(paths.intents, "invalid.json"), "{}\n", { mode: 0o600 });
    dispatcher.start();
    dispatcher.wake();
    await scanning;
    const failure = await dispatcher.whenFailed();
    expect(dispatcher.healthy()).toBe(false);
    dispatcher.stop();
    expect(failure.message).toMatch(/intent|record|catalog/i);
    await expect(dispatcher.close()).rejects.toBe(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", recordUnhandled);
    await rm(repository, { recursive: true, force: true });
  }
});
