import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";

export const maximumDeliveryIntentBytes = 4 * 1024;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const intentBase = {
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^[0-9a-f]{64}$/),
  eventDigest: digest,
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  envelopeId: z.string().regex(/^[0-9a-f]{64}$/),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  serviceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  destinationDigest: digest,
  ownerRequestId: z.string().min(1).max(256)
} as const;

export const deliveryIntentSchema = z.discriminatedUnion("state", [
  z.object({ ...intentBase, state: z.literal("pending") }).strict().readonly(),
  z.object({
    ...intentBase,
    state: z.literal("completed"),
    executionId: z.string().uuid()
  }).strict().readonly(),
  z.object({
    ...intentBase,
    state: z.literal("superseded"),
    rejectionStatus: z.union([z.literal(404), z.literal(409)]),
    rejectedAt: z.number().int().positive(),
    retryAfter: z.number().int().positive()
  }).strict().readonly()
]);

export type DeliveryIntent = z.infer<typeof deliveryIntentSchema>;
export type DeliveryIntentRecordVersion = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
};
export type StoredDeliveryIntent = { readonly intent: DeliveryIntent; readonly stat: BigIntStats };

export async function readStoredDeliveryIntent(
  path: string,
  singleLink = false
): Promise<StoredDeliveryIntent> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    assertDeliveryIntentRecord(before, singleLink);
    if (before.size > BigInt(maximumDeliveryIntentBytes)) {
      throw new DeliveryIntentRecordError("authoritative delivery intent exceeds its storage bound");
    }
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    const after = await file.stat({ bigint: true });
    const canonical = await lstat(path, { bigint: true });
    assertDeliveryIntentRecord(after, singleLink);
    assertDeliveryIntentRecord(canonical, singleLink);
    if (!sameDeliveryIntentRecordVersion(
      deliveryIntentRecordVersion(before), deliveryIntentRecordVersion(after)
    ) || !sameDeliveryIntentRecordVersion(
      deliveryIntentRecordVersion(after), deliveryIntentRecordVersion(canonical)
    )) {
      throw new DeliveryIntentRecordError(
        "authoritative delivery intent changed during verified read"
      );
    }
    return { intent: deliveryIntentSchema.parse(value), stat: after };
  } finally {
    await file.close();
  }
}

export async function inspectDeliveryIntentRecordVersion(
  path: string,
  singleLink = false
): Promise<DeliveryIntentRecordVersion> {
  const stat = await lstat(path, { bigint: true });
  assertDeliveryIntentRecord(stat, singleLink);
  if (stat.size > BigInt(maximumDeliveryIntentBytes)) {
    throw new DeliveryIntentRecordError("authoritative delivery intent exceeds its storage bound");
  }
  return deliveryIntentRecordVersion(stat);
}

export function deliveryIntentRecordVersion(stat: BigIntStats): DeliveryIntentRecordVersion {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs, uid: stat.uid, mode: stat.mode, nlink: stat.nlink };
}

export function deliveryIntentRecordVersionKey(version: DeliveryIntentRecordVersion): string {
  return [version.dev, version.ino, version.size, version.mtimeNs, version.ctimeNs,
    version.uid, version.mode, version.nlink].join(":");
}

export function sameDeliveryIntentRecordIdentityKey(
  key: string,
  version: DeliveryIntentRecordVersion
): boolean {
  return key.startsWith(`${String(version.dev)}:${String(version.ino)}:`);
}

export function sameDeliveryIntentRecordVersion(
  left: DeliveryIntentRecordVersion,
  right: DeliveryIntentRecordVersion
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink;
}

export async function readStoredDeliveryIntentIfPresent(
  path: string,
  singleLink = false
): Promise<StoredDeliveryIntent | undefined> {
  try {
    return await readStoredDeliveryIntent(path, singleLink);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function deliveryIntentKey(
  intent: Pick<DeliveryIntent, "eventId" | "generationId" | "serviceId" | "destinationDigest">
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      intent.eventId,
      intent.generationId,
      intent.serviceId,
      intent.destinationDigest
    ]))
    .digest("hex");
}

export function sameDeliveryIntentIdentity(left: DeliveryIntent, right: DeliveryIntent): boolean {
  return left.eventId === right.eventId
    && left.eventDigest === right.eventDigest
    && left.reviewId === right.reviewId
    && left.envelopeId === right.envelopeId
    && left.generationId === right.generationId
    && left.serviceId === right.serviceId
    && left.destinationDigest === right.destinationDigest;
}

export function deliveryIntentIdentity(intent: DeliveryIntent) {
  return {
    schemaVersion: 1 as const,
    eventId: intent.eventId,
    eventDigest: intent.eventDigest,
    reviewId: intent.reviewId,
    envelopeId: intent.envelopeId,
    generationId: intent.generationId,
    serviceId: intent.serviceId,
    destinationDigest: intent.destinationDigest,
    ownerRequestId: intent.ownerRequestId
  };
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new DeliveryIntentRecordError("authoritative delivery intents require a Linux user identity");
  }
  return uid;
}

function assertDeliveryIntentRecord(stat: BigIntStats, singleLink: boolean): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(serviceUid())
    || (stat.mode & 0o777n) !== 0o600n) {
    throw new DeliveryIntentRecordError(
      "authoritative delivery intent must be a caller-owned mode-0600 regular file"
    );
  }
  if (singleLink && stat.nlink !== 1n) {
    throw new DeliveryIntentRecordError(
      "authoritative delivery intent must be a single-link file"
    );
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class DeliveryIntentRecordError extends Error {
  readonly name = "DeliveryIntentRecordError";
}
