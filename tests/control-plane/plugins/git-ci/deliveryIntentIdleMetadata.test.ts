import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as intentRecords from "../../../../packages/gs/ci/src/delivery-intent-record.js";
import { readPendingAuthoritativeNativeDeliveries } from "../../../../packages/gs/ci/src/authoritative-native-delivery-store.js";
import { dimReviewJobAvailableEventCodec } from "../../../../packages/contracts/ci/src/execution-protocol.js";

it("keeps unchanged idle polling from modifying directory versions and rescanning retained metadata", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dim-intent-idle-metadata-"));
  try {
    const directory = join(repository, "dim-git-ci-deliveries", "intents");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const generationId = "5".repeat(64);
    const persistedBinding = { serviceId: "ci", destinationDigest: `sha256:${"6".repeat(64)}` };
    const binding = { ...persistedBinding, eventCodec: dimReviewJobAvailableEventCodec };
    for (let index = 0; index < 20; index += 1) {
      const intent = intentRecords.deliveryIntentSchema.parse({ schemaVersion: 1, state: "completed",
        eventId: createHash("sha256").update(String(index)).digest("hex"), eventDigest: `sha256:${"2".repeat(64)}`,
        reviewId: "3".repeat(64), envelopeId: "4".repeat(64), generationId, ...persistedBinding,
        ownerRequestId: `idle-${index}`, executionId: "00000000-0000-4000-8000-000000000001" });
      await writeFile(join(directory, `${intentRecords.deliveryIntentKey(intent)}.json`), `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    }
    expect(await readPendingAuthoritativeNativeDeliveries(repository, 1, binding, generationId)).toEqual([]);
    const before = await stat(directory, { bigint: true });
    const inspect = vi.spyOn(intentRecords, "inspectDeliveryIntentRecordVersion");
    expect(await readPendingAuthoritativeNativeDeliveries(repository, 1, binding, generationId)).toEqual([]);
    const after = await stat(directory, { bigint: true });
    expect(inspect).not.toHaveBeenCalled();
    expect(after.ctimeNs).toBe(before.ctimeNs);
  } finally {
    vi.restoreAllMocks();
    await rm(repository, { recursive: true, force: true });
  }
});
