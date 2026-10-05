import type { CandidateOrdinaryExecutionDescriptor } from "./candidate-execution-schema.js";

export type AdmittedExecution = {
  readonly descriptor: CandidateOrdinaryExecutionDescriptor;
  readonly descriptorDigest: string;
  readonly hostId: string;
  readonly capacity: string;
};

export type CurrentAttemptEvidence = {
  readonly reviewId: string;
  readonly attemptId: string;
  readonly descriptorDigest: string;
  readonly admissionGeneration: string;
  readonly hostId: string;
  readonly capacity: string;
};

export interface AdmissionVerifier {
  assertAdmitted(input: AdmittedExecution, signal: AbortSignal): Promise<void>;
  assertCurrentAttempt(input: CurrentAttemptEvidence, signal: AbortSignal): Promise<void>;
}

export interface BoundedAdmissionVerifier {
  assertAdmitted(input: AdmittedExecution): Promise<void>;
  assertCurrentAttempt(input: CurrentAttemptEvidence): Promise<void>;
}

export const admissionVerificationTimeoutMilliseconds = 5_000;

export function boundedAdmissionVerifier(
  verifier: AdmissionVerifier,
  timeoutMilliseconds = admissionVerificationTimeoutMilliseconds
): BoundedAdmissionVerifier {
  return {
    assertAdmitted: (input) => withinAdmissionVerificationDeadline(
      (signal) => verifier.assertAdmitted(input, signal),
      timeoutMilliseconds
    ),
    assertCurrentAttempt: (input) => withinAdmissionVerificationDeadline(
      (signal) => verifier.assertCurrentAttempt(input, signal),
      timeoutMilliseconds
    )
  };
}

export async function withinAdmissionVerificationDeadline(
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMilliseconds = admissionVerificationTimeoutMilliseconds
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AdmissionVerifierTimeoutError());
    }, timeoutMilliseconds);
  });
  try {
    await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function rejectingAdmissionVerifier(): AdmissionVerifier {
  return {
    async assertAdmitted() {
      throw new AdmissionVerifierUnavailableError();
    },
    async assertCurrentAttempt() {
      throw new AdmissionVerifierUnavailableError();
    }
  };
}

export class AdmissionVerifierUnavailableError extends Error {
  readonly name = "AdmissionVerifierUnavailableError";

  constructor() {
    super("ordinary CI admission verifier is unavailable");
  }
}

export class AdmissionVerifierTimeoutError extends Error {
  readonly name = "AdmissionVerifierTimeoutError";

  constructor() {
    super("ordinary CI admission verification timed out");
  }
}
