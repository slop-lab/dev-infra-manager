/** Fault points for the CI delivery journal's actual durable publication boundary. */
export interface CiDeliveryPublicationFaults {
  readonly beforeFileSync?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
  readonly beforeDirectorySync?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
}
