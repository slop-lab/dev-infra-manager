import { publishReviewRecord, replaceReviewRecord } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { join } from "node:path";
import {
  publishCatalogDeliveryIntent,
  reserveCatalogDeliveryIntentAdditions,
  reserveCatalogDeliveryIntentReplacement,
  resolveCatalogDeliveryIntentRetained,
  retainCatalogDeliveryIntentAddition,
  retainCatalogDeliveryIntentReplacement,
  type DeliveryIntentSelectionOrder
} from "./delivery-intent-catalog.js";
import {
  readStoredDeliveryIntent,
  sameDeliveryIntentIdentity,
  type DeliveryIntent
} from "./delivery-intent-record.js";

export type DeliveryIntentPublicationPaths = {
  readonly intents: string;
  readonly staging: string;
};

export type DeliveryIntentPublicationCandidate = {
  readonly name: string;
  readonly intent: DeliveryIntent;
  readonly order: DeliveryIntentSelectionOrder;
};

export type DeliveryIntentCatalogPublicationFaults = {
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
};

export async function publishCatalogDeliveryIntentAdditions(
  paths: DeliveryIntentPublicationPaths,
  candidates: readonly DeliveryIntentPublicationCandidate[],
  faults: DeliveryIntentCatalogPublicationFaults = {}
): Promise<void> {
  const reservation = reserveCatalogDeliveryIntentAdditions(paths.intents, candidates);
  try {
    for (const candidate of candidates) {
      const path = join(paths.intents, candidate.name);
      let admitted = false;
      try {
        let published = false;
        try {
          await publishReviewRecord({ path, serialized: `${JSON.stringify(candidate.intent)}\n`,
            stagingRoot: paths.staging, faults: faults.beforePublish === undefined
              ? {}
              : { beforePublish: faults.beforePublish } });
          published = true;
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
        }
        if (published) await faults.afterPublish?.();
        const stored = await readStoredDeliveryIntent(path, true);
        if (!sameDeliveryIntentIdentity(stored.intent, candidate.intent)) {
          throw new DeliveryIntentCatalogPublicationError(
            "authoritative delivery intent conflicts"
          );
        }
        publishCatalogDeliveryIntent(paths.intents, { name: candidate.name,
          stored, order: candidate.order }, reservation);
        admitted = true;
      } catch (error) {
        if (!admitted) {
          retainCatalogDeliveryIntentAddition(paths.intents, reservation, candidate);
          await resolveCatalogDeliveryIntentRetained(paths.intents);
        }
        throw error;
      }
    }
  } finally {
    reservation.release();
  }
}

export async function replaceCatalogDeliveryIntent(input: {
  readonly paths: DeliveryIntentPublicationPaths;
  readonly name: string;
  readonly next: DeliveryIntent;
  readonly order?: DeliveryIntentSelectionOrder;
  readonly faults?: DeliveryIntentCatalogPublicationFaults;
}): Promise<void> {
  const reservation = reserveCatalogDeliveryIntentReplacement(
    input.paths.intents, input.name, input.next, input.order
  );
  let admitted = false;
  try {
    await replaceReviewRecord({ path: join(input.paths.intents, input.name),
      serialized: `${JSON.stringify(input.next)}\n`, stagingRoot: input.paths.staging,
      faults: {
        ...(input.faults?.beforePublish === undefined
          ? {}
          : { beforePublish: input.faults.beforePublish }),
        ...(input.faults?.afterPublish === undefined
          ? {}
          : { afterPublish: input.faults.afterPublish })
      } });
    const stored = await readStoredDeliveryIntent(join(input.paths.intents, input.name), true);
    publishCatalogDeliveryIntent(input.paths.intents, { name: input.name, stored,
      ...(input.order === undefined ? {} : { order: input.order }) }, reservation);
    admitted = true;
  } catch (error) {
    if (!admitted) {
      retainCatalogDeliveryIntentReplacement(
        input.paths.intents, reservation, input.name, input.next, input.order
      );
      await resolveCatalogDeliveryIntentRetained(input.paths.intents);
    }
    throw error;
  } finally {
    reservation.release();
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class DeliveryIntentCatalogPublicationError extends Error {
  readonly name = "DeliveryIntentCatalogPublicationError";
}
