export class NativeHostCleanupError extends Error {
  readonly name = "NativeHostCleanupError";
  constructor(readonly claimId: string) { super(`owned native ordinary container cleanup failed for claim '${claimId}'`); }
}

export class NativeHostLaunchError extends Error {
  readonly name = "NativeHostLaunchError";
  constructor() { super("native ordinary Sysbox container did not start"); }
}

export class NativeHostLeaseError extends Error {
  readonly name = "NativeHostLeaseError";
  constructor(readonly claimId: string) { super(`native ordinary claim lease was lost for claim '${claimId}'`); }
}

export class NativeHostRecoveryError extends Error {
  readonly name = "NativeHostRecoveryError";
  constructor(readonly claimId: string, executionError: unknown, readonly recoveryError: unknown) {
    super(`native ordinary claim recovery failed for claim '${claimId}'`, { cause: executionError });
  }
}

export class NativeHostFinalizationUncertainError extends Error {
  readonly name = "NativeHostFinalizationUncertainError";
}
