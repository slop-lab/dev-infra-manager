import { expect, it } from "vitest";
import { selectExposureUrl } from "./exposure.js";

const expected = { workspace: "dim-smoke-owned", ingress: "practical", port: 3000, protocol: "http" as const, containers: [] };
export function publicExposure(port = 3000, url = "https://owned.example.test") {
  return { urls: [{ id: "11111111-1111-4111-8111-111111111111", workspace: expected.workspace, ingress: expected.ingress,
    subdomain: "owned", target: { containers: [] as string[], port, protocol: "http" }, url,
    permalink: `${url}/_dim/11111111-1111-4111-8111-111111111111`, approval: "approved", createdAt: "2026-11-06T15:00:00.000Z" }] };
}

it("decodes production public urls envelopes for distinct application and OpenCode targets", () => {
  expect(selectExposureUrl(publicExposure(), expected)).toBe("https://owned.example.test");
  expect(selectExposureUrl(publicExposure(4096), { ...expected, port: 4096 })).toBe("https://owned.example.test");
});

it.each([
  ["flat alias", { url: "https://owned.example.test" }],
  ["empty", { urls: [] }],
  ["ambiguous", { urls: [...publicExposure().urls, ...publicExposure().urls] }],
  ["foreign workspace", { urls: publicExposure().urls.map((entry) => ({ ...entry, workspace: "foreign" })) }],
  ["foreign ingress", { urls: publicExposure().urls.map((entry) => ({ ...entry, ingress: "foreign" })) }],
  ["wrong target", publicExposure(4096)],
  ["wrong protocol", { urls: publicExposure().urls.map((entry) => ({ ...entry, target: { ...entry.target, protocol: "https" } })) }],
  ["nested target", { urls: publicExposure().urls.map((entry) => ({ ...entry, target: { ...entry.target, containers: ["foreign"] } })) }],
  ["pending approval", { urls: publicExposure().urls.map((entry) => ({ ...entry, approval: "pending" })) }],
  ["revoked approval", { urls: publicExposure().urls.map((entry) => ({ ...entry, approval: "revoked" })) }],
  ["credential URL", publicExposure(3000, "https://user:secret@owned.example.test")],
  ["unsafe scheme", publicExposure(3000, "file:///etc/passwd")],
  ["query URL", publicExposure(3000, "https://owned.example.test?secret=value")],
  ["fragment URL", publicExposure(3000, "https://owned.example.test#secret")],
  ["malformed timestamp", { urls: publicExposure().urls.map((entry) => ({ ...entry, createdAt: "yesterday" })) }],
  ["private fields", { urls: publicExposure().urls.map((entry) => ({ ...entry, workspaceId: "private" })) }]
])("rejects %s rather than selecting an unrelated or unsafe route", (_label, value) => {
  expect(() => selectExposureUrl(value, expected)).toThrow();
});
