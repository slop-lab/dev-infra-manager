import { dimReviewJobAvailableEventCodec } from "@slop-lab/dim-contracts-ci/execution";
import { authoritativeNativeDeliveryBinding } from "@slop-lab/gs-ci";

export function dimDeliveryBinding(serviceId: string, endpoint: string) {
  return authoritativeNativeDeliveryBinding(serviceId, endpoint, dimReviewJobAvailableEventCodec);
}
