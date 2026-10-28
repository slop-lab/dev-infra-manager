import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { authoritativeNativeDeliveryBinding } from "../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { createAuthoritativeNativeReviewEnvelope } from "../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";
import { projectionDigestInput } from "../../control-plane/plugins/git-ci/projectionDigestFixture.js";
import { seedRetainedHistoryIntents } from "./native-history-intents.js";
import { verifyRetainedHistoryIntents } from "./native-history-intent-verification.js";

test("binds retained-intent load evidence to actual post-write counts, bytes and content fingerprint", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dim-retained-intent-evidence-"));
  try {
    const result: unknown = await seedRetainedHistoryIntents({ repository,
      envelope: createAuthoritativeNativeReviewEnvelope(projectionDigestInput),
      binding: authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs"), generationId: "a".repeat(64) });
    const descriptor = z.object({ recordCount: z.literal(10_000), bytes: z.number().int().positive(),
      fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict().parse(result);
    const directory = join(repository, "dim-git-ci-deliveries", "intents");
    const names = (await readdir(directory)).sort();
    const hash = createHash("sha256").update("dim-native-history-intents-v1\0");
    let bytes = 0;
    for (const name of names) {
      const content = await readFile(join(directory, name));
      hash.update(name).update("\0").update(content);
      bytes += content.length;
    }
    assert.equal(descriptor.recordCount, names.length);
    assert.equal(descriptor.bytes, bytes);
    assert.equal(descriptor.fingerprint, `sha256:${hash.digest("hex")}`);
  } finally { await rm(repository, { recursive: true, force: true }); }
});

test("rejects a same-size retained-intent mutation despite unchanged counts and recorded bytes", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dim-retained-intent-mutation-"));
  try {
    const descriptor = await seedRetainedHistoryIntents({ repository,
      envelope: createAuthoritativeNativeReviewEnvelope(projectionDigestInput),
      binding: authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs"), generationId: "a".repeat(64) });
    const directory = join(repository, "dim-git-ci-deliveries", "intents");
    const name = (await readdir(directory))[0];
    assert.ok(name);
    const path = join(directory, name), original = await readFile(path, "utf8");
    const changed = original.replace("synthetic-retained", "synthetic-detained");
    assert.notEqual(changed, original);
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    await writeFile(path, changed);
    await assert.rejects(verifyRetainedHistoryIntents(directory, descriptor), /no longer matches/);
  } finally { await rm(repository, { recursive: true, force: true }); }
});
