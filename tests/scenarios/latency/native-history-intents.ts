import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveryIntentKey, deliveryIntentSchema } from "../../../packages/control-plane/plugins/git-ci/src/delivery-intent-record.js";
import type { AuthoritativeNativeDeliveryBinding } from "../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import type { AuthoritativeNativeReviewEnvelope } from "../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";

export async function seedRetainedHistoryIntents(input: {
  readonly repository: string;
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly binding: AuthoritativeNativeDeliveryBinding;
  readonly generationId: string;
}): Promise<number> {
  const directory = join(input.repository, "dim-git-ci-deliveries", "intents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const event = input.envelope.events[0];
  if (event === undefined) throw new NativeHistoryIntentFixtureError("history fixture has no canonical CI event");
  const eventDigest = `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
  const count = 10_000;
  for (let index = 1; index <= count; index += 1) {
    let generationId = index.toString(16).padStart(64, "0");
    if (generationId === input.generationId) generationId = `${"f".repeat(60)}${index.toString(16).padStart(4, "0")}`;
    const intent = deliveryIntentSchema.parse({ schemaVersion: 1, state: "completed",
      eventId: event.eventId, eventDigest, reviewId: event.reviewId, envelopeId: event.envelopeId,
      generationId, serviceId: index % 3 === 0 ? "historical-ci" : input.binding.serviceId,
      destinationDigest: index % 3 === 1 ? `sha256:${"f".repeat(64)}` : input.binding.destinationDigest,
      ownerRequestId: `synthetic-retained-${index}`, executionId: "00000000-0000-4000-8000-000000000001" });
    await writeFile(join(directory, `${deliveryIntentKey(intent)}.json`), `${JSON.stringify(intent)}\n`, { mode: 0o600, flag: "wx" });
  }
  return count;
}

export class NativeHistoryIntentFixtureError extends Error {
  readonly name = "NativeHistoryIntentFixtureError";
}
