import { createHash } from "node:crypto";
import type { ReviewCheckAvailableEvent } from "@slop-lab/gs-ci-contracts";

export interface CiDeliveryEventCodec {
  serialize(event: ReviewCheckAvailableEvent): string;
}

export type AuthoritativeNativeDeliveryBinding = {
  readonly serviceId: string;
  readonly destinationDigest: string;
  readonly eventCodec: CiDeliveryEventCodec;
};

export function authoritativeNativeDeliveryBinding(
  serviceId: string,
  endpoint: string,
  eventCodec: CiDeliveryEventCodec,
): AuthoritativeNativeDeliveryBinding {
  const destinationDigest = createHash("sha256")
    .update("dim-native-event-destination-v1\0")
    .update(JSON.stringify({ endpoint, serviceId }))
    .digest("hex");
  return { serviceId, destinationDigest: `sha256:${destinationDigest}`, eventCodec };
}

export const jsonCiDeliveryEventCodec: CiDeliveryEventCodec = {
  serialize: (event) => JSON.stringify(event),
};
