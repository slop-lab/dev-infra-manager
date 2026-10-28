import type { DeliveryIntent } from "./delivery-intent-record.js";

export type DeliveryIntentSelectionOrder = {
  readonly createdAt: string;
  readonly reviewId: string;
  readonly jobName: string;
  readonly eventId: string;
};

export type CatalogEntry = {
  readonly name: string;
  readonly intent: DeliveryIntent;
  readonly version: string;
  readonly bytes: number;
  readonly order?: DeliveryIntentSelectionOrder;
};

export type CatalogBucket = {
  pending: CatalogEntry[];
  pendingSorted: boolean;
  eligible: CatalogEntry[];
  future: CatalogEntry[];
  futureSorted: boolean;
  unordered: CatalogEntry[];
  observedAt?: number;
};

export type OrderedIntentCursor = {
  readonly kind: "ordered";
  readonly nextGroup: () => readonly DeliveryIntent[];
};

export type UnprimedIntentCursor = {
  readonly kind: "unprimed";
  readonly intents: readonly DeliveryIntent[];
};

export type DeliveryIntentCursor = OrderedIntentCursor | UnprimedIntentCursor;

export function deliveryIntentBucketKey(intent: DeliveryIntent): string {
  return `${intent.generationId}\0${intent.serviceId}\0${intent.destinationDigest}`;
}

export function addCatalogEntry(buckets: Map<string, CatalogBucket>, entry: CatalogEntry,
  bulk = false): void {
  if (entry.intent.state === "completed") return;
  const key = deliveryIntentBucketKey(entry.intent);
  const bucket = buckets.get(key) ?? {
    pending: [], pendingSorted: true, eligible: [], future: [], futureSorted: true, unordered: []
  };
  if (entry.order === undefined) {
    if (bulk) bucket.unordered.push(entry);
    else bucket.unordered = [...bucket.unordered, entry];
  } else if (entry.intent.state === "pending") {
    if (bulk || !bucket.pendingSorted) {
      bucket.pending.push(entry);
      bucket.pendingSorted = false;
    } else bucket.pending = insertOrdered(bucket.pending, entry, compareEntryOrder);
  } else {
    if (bulk || !bucket.futureSorted) {
      bucket.future.push(entry);
      bucket.futureSorted = false;
    } else bucket.future = insertOrdered(bucket.future, entry, compareRetryOrder);
  }
  buckets.set(key, bucket);
}

export function removeCatalogEntry(buckets: Map<string, CatalogBucket>, entry: CatalogEntry): void {
  if (entry.intent.state === "completed") return;
  const key = deliveryIntentBucketKey(entry.intent);
  const bucket = buckets.get(key);
  if (bucket === undefined) return;
  bucket.pending = withoutEntry(bucket.pending, entry.name);
  bucket.eligible = withoutEntry(bucket.eligible, entry.name);
  bucket.future = withoutEntry(bucket.future, entry.name);
  bucket.unordered = withoutEntry(bucket.unordered, entry.name);
  if (bucket.pending.length === 0 && bucket.eligible.length === 0
    && bucket.future.length === 0 && bucket.unordered.length === 0) {
    buckets.delete(key);
  }
}

export function selectableIntentCursor(bucket: CatalogBucket | undefined, now: number): DeliveryIntentCursor {
  if (bucket === undefined) return orderedCursor([], []);
  if (bucket.observedAt !== undefined && now < bucket.observedAt) {
    bucket.future = [...bucket.future, ...bucket.eligible];
    bucket.eligible = [];
    bucket.futureSorted = false;
  }
  bucket.observedAt = now;
  if (!bucket.pendingSorted) {
    bucket.pending = [...bucket.pending].sort(compareEntryOrder);
    bucket.pendingSorted = true;
  }
  if (!bucket.futureSorted) {
    bucket.future = [...bucket.future].sort(compareRetryOrder);
    bucket.futureSorted = true;
  }
  while (bucket.future[0]?.intent.state === "superseded"
    && bucket.future[0].intent.retryAfter <= now) {
    const due = bucket.future.shift();
    if (due !== undefined) bucket.eligible = insertOrdered(bucket.eligible, due, compareEntryOrder);
  }
  const activeUnordered = bucket.unordered.filter((entry) => entry.intent.state === "pending"
    || entry.intent.state === "superseded" && entry.intent.retryAfter <= now);
  if (activeUnordered.length > 0) {
    return {
      kind: "unprimed",
      intents: [...bucket.pending, ...bucket.eligible, ...activeUnordered].map(({ intent }) => intent)
    };
  }
  return orderedCursor(bucket.pending, bucket.eligible);
}

export function compareSelectionOrder(left: DeliveryIntentSelectionOrder,
  right: DeliveryIntentSelectionOrder): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.reviewId.localeCompare(right.reviewId)
    || left.jobName.localeCompare(right.jobName)
    || left.eventId.localeCompare(right.eventId);
}

function orderedCursor(pending: readonly CatalogEntry[], eligible: readonly CatalogEntry[]): OrderedIntentCursor {
  let pendingIndex = 0;
  let eligibleIndex = 0;
  return { kind: "ordered", nextGroup() {
    const first = takeNext();
    if (first === undefined) return [];
    const group = [first.intent];
    while (true) {
      const next = peekNext();
      if (next?.order === undefined || first.order === undefined
        || next.order.createdAt !== first.order.createdAt
        || next.order.reviewId !== first.order.reviewId) return group;
      const selected = takeNext();
      if (selected !== undefined) group.push(selected.intent);
    }
  } };

  function peekNext(): CatalogEntry | undefined {
    const nextPending = pending[pendingIndex];
    const nextEligible = eligible[eligibleIndex];
    if (nextPending === undefined) return nextEligible;
    if (nextEligible === undefined) return nextPending;
    return compareEntryOrder(nextPending, nextEligible) <= 0 ? nextPending : nextEligible;
  }

  function takeNext(): CatalogEntry | undefined {
    const next = peekNext();
    if (next === pending[pendingIndex]) pendingIndex += 1;
    else if (next !== undefined) eligibleIndex += 1;
    return next;
  }
}

function compareEntryOrder(left: CatalogEntry, right: CatalogEntry): number {
  if (left.order === undefined || right.order === undefined) return left.name.localeCompare(right.name);
  return compareSelectionOrder(left.order, right.order) || left.name.localeCompare(right.name);
}

function compareRetryOrder(left: CatalogEntry, right: CatalogEntry): number {
  if (left.intent.state !== "superseded" || right.intent.state !== "superseded") {
    return left.name.localeCompare(right.name);
  }
  return left.intent.retryAfter - right.intent.retryAfter || compareEntryOrder(left, right);
}

function insertOrdered(entries: readonly CatalogEntry[], entry: CatalogEntry,
  compare: (left: CatalogEntry, right: CatalogEntry) => number): CatalogEntry[] {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = entries[middle];
    if (candidate !== undefined && compare(candidate, entry) <= 0) low = middle + 1;
    else high = middle;
  }
  return [...entries.slice(0, low), entry, ...entries.slice(low)];
}

function withoutEntry(entries: readonly CatalogEntry[], name: string): CatalogEntry[] {
  return entries.filter((entry) => entry.name !== name);
}
