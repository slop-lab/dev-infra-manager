import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { AuthoritativeNativeChangedPath } from "./authoritative-native-review-schema.js";
import { jsonFieldMatcher } from "./json-field-matcher.js";

/** Trusted provider code. Candidate changes cannot select their own review requirements. */
export interface ReviewChangeMatcher {
  readonly name: string;
  /** SHA256 of reviewed implementation and every provider setting affecting matching semantics. */
  readonly revision: string;
  validate(options: unknown): void;
  matches(input: { readonly options: unknown; readonly changes: readonly AuthoritativeNativeChangedPath[]; readonly readBlob: (objectId: string) => Promise<Buffer>; readonly readCandidateFile: (path: string) => Promise<Buffer | undefined>; readonly readBaseFile?: (path: string) => Promise<Buffer | undefined> }): Promise<boolean | { readonly matches: boolean; readonly evidenceDigest: string }>;
}
export const reviewChangeMatcherKind = "dim.code-review.change-matcher";
export function assertReviewChangeMatchers(matchers: readonly ReviewChangeMatcher[]): void {
  const names = new Set<string>();
  for (const matcher of matchers) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(matcher.name)
      || !/^[0-9a-f]{64}$/.test(matcher.revision)
      || typeof matcher.validate !== "function" || typeof matcher.matches !== "function") throw new Error("invalid review change matcher");
    if (names.has(matcher.name)) throw new Error(`duplicate review change matcher '${matcher.name}'`);
    names.add(matcher.name);
  }
}
export function reviewChangeMatcherExtension(matcher: ReviewChangeMatcher): ControlPlaneExtension {
  assertReviewChangeMatchers([matcher]);
  return { kind: reviewChangeMatcherKind, name: matcher.name, value: matcher };
}
export function defaultReviewChangeMatchers(): readonly ReviewChangeMatcher[] { return [jsonFieldMatcher]; }
export function reviewChangeMatchers(extensions: readonly ControlPlaneExtension[]): readonly ReviewChangeMatcher[] {
  const matchers = [...defaultReviewChangeMatchers(), ...extensions.filter(({ kind }) => kind === reviewChangeMatcherKind).map(({ name, value }) => {
    if (!("name" in value) || value.name !== name) throw new Error(`invalid review change matcher '${name}'`);
    return value as ReviewChangeMatcher;
  })];
  assertReviewChangeMatchers(matchers);
  return matchers;
}
