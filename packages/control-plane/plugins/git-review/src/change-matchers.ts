import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  assertReviewChangeMatchers,
  defaultReviewChangeMatchers,
  type ReviewChangeMatcher,
} from "@slop-lab/gs-review";

export type { ReviewChangeMatcher } from "@slop-lab/gs-review";
export { assertReviewChangeMatchers, defaultReviewChangeMatchers };

export const reviewChangeMatcherKind = "dim.code-review.change-matcher";

export function reviewChangeMatcherExtension(matcher: ReviewChangeMatcher): ControlPlaneExtension {
  assertReviewChangeMatchers([matcher]);
  return { kind: reviewChangeMatcherKind, name: matcher.name, value: matcher };
}

export function reviewChangeMatchers(extensions: readonly ControlPlaneExtension[]): readonly ReviewChangeMatcher[] {
  const selected = extensions
    .filter(({ kind }) => kind === reviewChangeMatcherKind)
    .map(({ name, value }) => {
      if (!isReviewChangeMatcher(value) || value.name !== name) {
        throw new ReviewChangeMatcherExtensionError(`invalid review change matcher '${name}'`);
      }
      return value;
    });
  const matchers = [...defaultReviewChangeMatchers(), ...selected];
  assertReviewChangeMatchers(matchers);
  return matchers;
}

function isReviewChangeMatcher(value: unknown): value is ReviewChangeMatcher {
  return typeof value === "object" && value !== null
    && "name" in value && typeof value.name === "string"
    && "revision" in value && typeof value.revision === "string"
    && "validate" in value && typeof value.validate === "function"
    && "matches" in value && typeof value.matches === "function";
}

export class ReviewChangeMatcherExtensionError extends Error {
  readonly name = "ReviewChangeMatcherExtensionError";
}
