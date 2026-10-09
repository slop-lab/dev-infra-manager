import {
  createAuthoritativeNativeReview,
  type AuthoritativeNativeReviewHooks
} from "./authoritative-native-review.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { RootReadOperationGate } from "./native-root-read-lifecycle.js";

type ReviewControllerInput = {
  readonly available: () => boolean;
  readonly hooks?: AuthoritativeNativeReviewHooks;
  readonly operations: RootReadOperationGate;
  readonly runtime: AuthoritativeNativeCandidateRuntime;
};

export type AuthoritativeNativeReviewController = {
  readonly create: (input: unknown) => Promise<AuthoritativeNativeReviewEnvelope>;
  readonly waitForIdle: () => Promise<void>;
};

export function createAuthoritativeNativeReviewController(
  input: ReviewControllerInput
): AuthoritativeNativeReviewController {
  let queue = Promise.resolve();
  return {
    create(selector) {
      if (!input.available()) {
        return Promise.reject(new AuthoritativeNativeReviewControllerError("native Git bundle server is closed"));
      }
      const operation = queue.then(async () => {
        const release = input.operations.acquire();
        if (release === undefined) {
          throw new AuthoritativeNativeReviewControllerError("native Git bundle review admission is unavailable");
        }
        try {
          return await createAuthoritativeNativeReview(input.runtime, selector, input.hooks);
        } finally {
          release();
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    waitForIdle() {
      return queue;
    }
  };
}

export class AuthoritativeNativeReviewControllerError extends Error {
  readonly name = "AuthoritativeNativeReviewControllerError";
}
