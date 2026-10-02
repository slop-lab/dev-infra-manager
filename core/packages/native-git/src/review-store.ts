import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseReviewObject,
  reviewApprovalSchema,
  reviewRevocationSchema,
  type ReviewApproval,
  type ReviewObject,
  type ReviewRevocation
} from "./review-schema.js";

const filePattern = /^[0-9a-f-]+\.json$/;
const MAX_RECORD_BYTES = 128 * 1024 * 1024;

export type ReviewStore = {
  saveReview(review: ReviewObject): Promise<ReviewObject>;
  readReview(reviewId: string): Promise<ReviewObject | undefined>;
  saveApproval(input: Omit<ReviewApproval, "approvalId" | "approvedAt" | "schemaVersion">): Promise<ReviewApproval>;
  readApprovals(reviewId: string): Promise<readonly ReviewApproval[]>;
  saveRevocation(input: Omit<ReviewRevocation, "revokedAt" | "schemaVersion">): Promise<ReviewRevocation>;
  readRevocations(reviewId: string): Promise<readonly ReviewRevocation[]>;
};

export async function initializeReviewStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews");
  await ownedDirectory(root);
  await Promise.all(["proposals", "approvals", "revocations"].map((name) => ownedDirectory(join(root, name))));
}

export async function assertReviewStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews");
  for (const name of ["", "proposals", "approvals", "revocations"]) {
    await assertOwnedDirectory(name.length === 0 ? root : join(root, name));
  }
  const proposalRoot = join(root, "proposals");
  for (const entry of await readdir(proposalRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) throw new ReviewStoreError("review store contains an invalid proposal entry");
    const review = parseReviewObject(await readJson(join(proposalRoot, entry.name)));
    if (`${review.reviewId}.json` !== entry.name) throw new ReviewStoreError("review proposal path does not match its identity");
  }
  for (const category of ["approvals", "revocations"] as const) {
    const categoryRoot = join(root, category);
    for (const entry of await readdir(categoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) throw new ReviewStoreError("review store contains an invalid event directory");
      await assertOwnedDirectory(join(categoryRoot, entry.name));
      for (const file of await readdir(join(categoryRoot, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !filePattern.test(file.name)) throw new ReviewStoreError("review store contains an invalid event entry");
        const value = await readJson(join(categoryRoot, entry.name, file.name));
        if (category === "approvals") {
          const approval = reviewApprovalSchema.parse(value);
          if (approval.reviewId !== entry.name || `${approval.approvalId}.json` !== file.name) {
            throw new ReviewStoreError("review approval path does not match its identity");
          }
        } else {
          const revocation = reviewRevocationSchema.parse(value);
          if (revocation.reviewId !== entry.name || `${revocation.approvalId}.json` !== file.name) {
            throw new ReviewStoreError("review revocation path does not match its identity");
          }
        }
      }
    }
  }
}

export function createReviewStore(repositoryPath: string): ReviewStore {
  const root = join(repositoryPath, "dim-reviews");
  return {
    async saveReview(review) {
      const path = join(root, "proposals", `${review.reviewId}.json`);
      try {
        await writeImmutable(path, review);
        return review;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const existing = parseReviewObject(await readJson(path));
        if (existing.reviewId !== review.reviewId) throw new ReviewStoreError("review identity collision");
        return existing;
      }
    },
    async readReview(reviewId) {
      const path = join(root, "proposals", `${reviewId}.json`);
      try {
        return parseReviewObject(await readJson(path));
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async saveApproval(input) {
      const approval = reviewApprovalSchema.parse({
        ...input,
        schemaVersion: 1,
        approvalId: randomUUID(),
        approvedAt: new Date().toISOString()
      });
      const directory = join(root, "approvals", approval.reviewId);
      await ownedDirectory(directory);
      await writeImmutable(join(directory, `${approval.approvalId}.json`), approval);
      return approval;
    },
    async readApprovals(reviewId) {
      return readEvents(join(root, "approvals", reviewId), reviewApprovalSchema.parse);
    },
    async saveRevocation(input) {
      const revocation = reviewRevocationSchema.parse({ ...input, schemaVersion: 1, revokedAt: new Date().toISOString() });
      const directory = join(root, "revocations", revocation.reviewId);
      await ownedDirectory(directory);
      const path = join(directory, `${revocation.approvalId}.json`);
      try {
        await writeImmutable(path, revocation);
        return revocation;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        return reviewRevocationSchema.parse(await readJson(path));
      }
    },
    async readRevocations(reviewId) {
      return readEvents(join(root, "revocations", reviewId), reviewRevocationSchema.parse);
    }
  };
}

async function readEvents<T>(directory: string, parse: (input: unknown) => T): Promise<readonly T[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const values: T[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !filePattern.test(entry.name)) throw new ReviewStoreError("review event entry is invalid");
    values.push(parse(await readJson(join(directory, entry.name))));
  }
  return values;
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
      throw new ReviewStoreError("review record must be a caller-owned mode-0600 regular file");
    }
    if (stat.size > MAX_RECORD_BYTES) throw new ReviewStoreError("review record exceeds the storage bound");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(path);
  await chmod(path, 0o700);
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid()) {
    throw new ReviewStoreError("review store must contain caller-owned directories");
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ReviewStoreError("native Git review requires a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ReviewStoreError extends Error {
  readonly name = "ReviewStoreError";
}
