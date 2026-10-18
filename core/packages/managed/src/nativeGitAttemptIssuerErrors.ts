export class NativeGitAttemptIssuerUnavailableError extends Error {
  readonly name = "NativeGitAttemptIssuerUnavailableError";

  constructor(options?: ErrorOptions) {
    super("native Git attempt issuer is unavailable", options);
  }
}

export class NativeGitAttemptIssuerRejectedError extends Error {
  readonly name = "NativeGitAttemptIssuerRejectedError";

  constructor(readonly statusCode: number) {
    super("native Git rejected the attempt issuer request");
  }
}
