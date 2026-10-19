import { expect, it } from "vitest";
import { parseNativeProjectPendingRecord } from "../../../../packages/host/plugins/native-git/src/nativeProjectPendingCodec.js";
import { projectRecord, repositoryRecord } from "./nativeProjectFixture.js";

it("represents one Project with independently bound repositories and separate configuration/working defaults", () => {
  const current = projectRecord();
  const record = parseNativeProjectPendingRecord({ ...current, configurationRepositoryId: "private", defaultWorkingRepositoryId: "public" });
  expect(record.repositories.public?.commit).not.toBe(record.repositories.private?.commit);
  expect(record.configurationRepositoryId).toBe("private");
  expect(record.defaultWorkingRepositoryId).toBe("public");
  expect(parseNativeProjectPendingRecord(record)).toEqual(record);
});
it("accepts an empty configuring Project without pretending it is ready", () => {
  const current = projectRecord();
  const { readyAt: _readyAt, ...base } = current.phase === "ready" ? current : { ...current, readyAt: "" };
  expect(parseNativeProjectPendingRecord({ ...base, phase: "configuring", configurationRepositoryId: null, defaultWorkingRepositoryId: null, repositories: {} }).phase).toBe("configuring");
});
it("rejects cross-repository receipts, altered policy, missing defaults and unrecognized fields", () => {
  const current = projectRecord(), repository = repositoryRecord("public");
  for (const invalid of [
    { ...current, configurationRepositoryId: "absent" },
    { ...current, defaultWorkingRepositoryId: "absent" },
    { ...current, repositoryId: "root" },
    { ...current, repositories: { public: { ...repository, importReceipt: repositoryRecord("private").importReceipt } } },
    { ...current, repositories: { public: { ...repository, reviewPolicy: { ...repository.reviewPolicy, ciRepositoryIds: ["private"] } } } },
    { ...current, repositories: { "../../private": repository } }
  ]) expect(() => parseNativeProjectPendingRecord(invalid)).toThrow();
});
