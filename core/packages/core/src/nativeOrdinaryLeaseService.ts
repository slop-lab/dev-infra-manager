import type { NativeJobAttemptIssuance, NativeJobAttemptRevocation } from "./nativeGitAttemptIssuerModel.js";
import type { NativeOrdinaryAuthorityStore } from "./nativeOrdinaryAuthorityStore.js";
import type {
  NativeHostClaimRenewal,
  NativeHostClaimRenewalRequest,
  NativeHostRecoveryRequest
} from "./nativeOrdinaryClaimProtocol.js";

export class NativeOrdinaryLeaseService {
  readonly #store: NativeOrdinaryAuthorityStore;
  readonly #issuer: NativeAttemptRevoker;

  constructor(store: NativeOrdinaryAuthorityStore, issuer: NativeAttemptRevoker) {
    this.#store = store;
    this.#issuer = issuer;
  }

  renew(request: NativeHostClaimRenewalRequest): NativeHostClaimRenewal | undefined {
    return this.#store.renewClaim(request);
  }

  async recover(request: NativeHostRecoveryRequest): Promise<"recovered" | "conflict"> {
    const prepared = this.#store.prepareRecovery(request);
    switch (prepared.kind) {
      case "conflict":
        return "conflict";
      case "released":
        return "recovered";
      case "pending": {
        const proof = await this.#issuer.revokeAttempt(prepared.issuance);
        return this.#store.completeRecovery(request, proof) ? "recovered" : "conflict";
      }
      default:
        return assertNever(prepared);
    }
  }
}

type NativeAttemptRevoker = {
  readonly revokeAttempt: (issuance: NativeJobAttemptIssuance) => Promise<NativeJobAttemptRevocation>;
};

function assertNever(value: never): never {
  throw new TypeError(`unexpected native recovery state: ${JSON.stringify(value)}`);
}
