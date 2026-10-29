import type { ReviewChangedPath } from "@slop-lab/gs-review-contracts";
import { jsonFieldMatcher } from "./json-field-matcher.js";

export interface ReviewChangeMatcher {
  readonly name: string;
  readonly revision: string;
  validate(options: unknown): void;
  matches(input: {
    readonly options: unknown;
    readonly changes: readonly ReviewChangedPath[];
    readonly readBlob: (objectId: string) => Promise<Buffer>;
    readonly readCandidateFile: (path: string) => Promise<Buffer | undefined>;
    readonly readBaseFile?: (path: string) => Promise<Buffer | undefined>;
  }): Promise<boolean | { readonly matches: boolean; readonly evidenceDigest: string }>;
}

export function assertReviewChangeMatchers(matchers: readonly ReviewChangeMatcher[]): void {
  const names = new Set<string>();
  for (const matcher of matchers) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(matcher.name)
      || !/^[0-9a-f]{64}$/.test(matcher.revision)
      || typeof matcher.validate !== "function" || typeof matcher.matches !== "function") {
      throw new ReviewChangeMatcherError("invalid review change matcher");
    }
    if (names.has(matcher.name)) throw new ReviewChangeMatcherError(`duplicate review change matcher '${matcher.name}'`);
    names.add(matcher.name);
  }
}

export function defaultReviewChangeMatchers(): readonly ReviewChangeMatcher[] {
  return [jsonFieldMatcher];
}

export class ReviewChangeMatcherError extends Error {
  readonly name = "ReviewChangeMatcherError";
}
