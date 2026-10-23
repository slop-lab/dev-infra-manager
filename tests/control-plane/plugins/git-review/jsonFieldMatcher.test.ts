import { expect, it } from "vitest";
import { jsonFieldMatcher } from "../../../../packages/control-plane/plugins/git-review/src/json-field-matcher.js";
import type { AuthoritativeNativeChangedPath } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js";

const path = "runtime.json";
const beforeId = "a".repeat(40), afterId = "b".repeat(40);
const change: AuthoritativeNativeChangedPath = {
  status: "modified", oldPath: path, newPath: path,
  oldPathBytes: Buffer.from(path).toString("base64"), newPathBytes: Buffer.from(path).toString("base64"),
  oldMode: "100644", newMode: "100644", oldObjectId: beforeId, newObjectId: afterId
};
async function matches(before: string, after: string, pointer = "/isolation", overrides: Partial<AuthoritativeNativeChangedPath> = {}) {
  return jsonFieldMatcher.matches({ options: { path, pointer }, changes: [{ ...change, ...overrides }],
    readBlob: async (id) => Buffer.from(id === beforeId ? before : after),
    readCandidateFile: async () => undefined });
}

it("ignores unrelated fields, formatting and object key order", async () => {
  expect(await matches('{"isolation":{"network":false,"mounts":[]},"theme":"dark"}',
    '{"theme":"light","isolation":{"mounts":[],"network":false}}')).toBe(false);
});
it.each([
  ['{"isolation":false}', '{"isolation":true}'],
  ['{"isolation":null}', '{}'],
  ['{}', '{"isolation":null}'],
  ['{"isolation":{}}', '{"isolation":{"mounts":["/host"]}}'],
  ['{"isolation":false}', '{"isolation":true,"isolation":false}'],
  ['{"isolation":false}', '{"isolation":false,"isol\\u0061tion":true}'],
  ['{"isolation":false}', '{"isolation":false,}'],
  ['{"isolation":false}', '//comment\n{"isolation":false}'],
  ['{"isolation":false}', '{invalid'],
  ['{"isolation":false}', '{"isolation":false,"ambiguous":9007199254740993}']
])("requires human review for protected or ambiguous JSON change: %s -> %s", async (before, after) => {
  expect(await matches(before, after)).toBe(true);
});
it("handles RFC6901 escapes, array indices and own properties", async () => {
  expect(await matches('{"a/b":{"~key":[false]}}', '{"a/b":{"~key":[true]}}', "/a~1b/~0key/0")).toBe(true);
  expect(await matches('{"__proto__":{"enabled":false}}', '{"__proto__":{"enabled":true}}', "/__proto__/enabled")).toBe(true);
  expect(await matches('{}', '{}', "/constructor")).toBe(false);
});
it.each([
  { oldPathBytes: "", oldObjectId: "0", status: "added" as const },
  { newPathBytes: "", newObjectId: "0", status: "deleted" as const },
  { newPathBytes: Buffer.from("renamed.json").toString("base64"), status: "renamed" as const },
  { newMode: "120000", status: "type-changed" as const },
  { newMode: "100755" }
])("requires review for protected document identity/type changes: %j", async (overrides) => {
  expect(await matches('{"isolation":false}', '{"isolation":false}', "/isolation", overrides)).toBe(true);
});
it("requires review on unreadable, oversized, excessively nested or invalid UTF8 data", async () => {
  expect(await matches('{}', ' '.repeat(1024 * 1024 + 1))).toBe(true);
  expect(await matches('{}', '['.repeat(65) + '0' + ']'.repeat(65))).toBe(true);
  expect(await jsonFieldMatcher.matches({ options: { path, pointer: "/isolation" }, changes: [change],
    readBlob: async () => { throw new Error("unavailable Git object"); }, readCandidateFile: async () => undefined })).toBe(true);
  expect(await jsonFieldMatcher.matches({ options: { path, pointer: "/isolation" }, changes: [change],
    readBlob: async () => Buffer.from([0xff]), readCandidateFile: async () => undefined })).toBe(true);
});
it("rejects ambiguous selector configuration instead of silently ignoring it", () => {
  for (const options of [{ path: "../runtime.json", pointer: "/isolation" }, { path, pointer: "/bad~2escape" }, { path, pointer: "isolation" }]) {
    expect(() => jsonFieldMatcher.validate(options)).toThrow();
  }
});
