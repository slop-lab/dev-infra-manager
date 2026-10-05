import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { recoverReviewAcknowledgementStaging } from "./review-acknowledgement-storage.js";
import { readReviewOutboxState } from "./review-outbox-state.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  readReviewJson,
  recoverPublishedReviewStaging
} from "./review-record-storage.js";
import { reviewApprovalSchema, reviewRevocationSchema } from "./review-schema.js";
import { ReviewStoreError } from "./review-store-errors.js";

const maximumRecordBytes = 128 * 1024 * 1024;
const maximumUndeliveredEvents = 10_000;
const maximumDeliveredEvents = 100_000;
const evidenceFilePattern = /^[0-9a-f-]+\.json$/;

export async function initializeReviewStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews");
  await ownedReviewDirectory(root);
  await Promise.all(["proposals", "staging", "approvals", "revocations", "delivered", "delivery-staging"]
    .map((name) => ownedReviewDirectory(join(root, name))));
}

export async function assertReviewStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews");
  for (const name of ["", "proposals", "staging", "approvals", "revocations", "delivered", "delivery-staging"]) {
    await assertOwnedReviewDirectory(name.length === 0 ? root : join(root, name));
  }
  const proposalRoot = join(root, "proposals");
  await recoverPublishedReviewStaging({ stagingRoot: join(root, "staging"), proposalRoot });
  await recoverReviewAcknowledgementStaging({
    stagingRoot: join(root, "delivery-staging"),
    deliveredRoot: join(root, "delivered")
  });
  await readReviewOutboxState({
    proposalRoot,
    deliveredRoot: join(root, "delivered"),
    maximumPending: maximumUndeliveredEvents,
    maximumDelivered: maximumDeliveredEvents
  });
  for (const category of ["approvals", "revocations"] as const) {
    const categoryRoot = join(root, category);
    for (const entry of await readdir(categoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) {
        throw new ReviewStoreError("review store contains an invalid event directory");
      }
      await assertOwnedReviewDirectory(join(categoryRoot, entry.name));
      for (const file of await readdir(join(categoryRoot, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !evidenceFilePattern.test(file.name)) {
          throw new ReviewStoreError("review store contains an invalid event entry");
        }
        const value = await readReviewJson(join(categoryRoot, entry.name, file.name), maximumRecordBytes);
        const evidence = category === "approvals" ? reviewApprovalSchema.parse(value) : reviewRevocationSchema.parse(value);
        if (evidence.reviewId !== entry.name || `${evidence.approvalId}.json` !== file.name) {
          throw new ReviewStoreError(`review ${category === "approvals" ? "approval" : "revocation"} path does not match its identity`);
        }
      }
    }
  }
}
