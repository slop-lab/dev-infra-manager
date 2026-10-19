import { createHash } from "node:crypto";

export type AuthoritativeNativeDeliveryBinding = {
  readonly serviceId: string;
  readonly destinationDigest: string;
};

export function authoritativeNativeDeliveryBinding(
  serviceId: string,
  endpoint: string
): AuthoritativeNativeDeliveryBinding {
  const destinationDigest = createHash("sha256")
    .update("dim-native-event-destination-v1\0")
    .update(JSON.stringify({ endpoint, serviceId }))
    .digest("hex");
  return { serviceId, destinationDigest: `sha256:${destinationDigest}` };
}
