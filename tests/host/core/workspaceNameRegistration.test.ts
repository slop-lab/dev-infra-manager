import { expect, it } from "vitest";
import { validateNameRegistration, validateWorkspaceInternalName, validateWorkspaceUpstream } from "@slop-lab/dim-host-core/workspace";

it("accepts lowercase hostnames under the reserved suffix and rejects everything else", () => {
  expect(validateWorkspaceInternalName("npm.cache.dim.internal")).toBe("npm.cache.dim.internal");
  expect(validateWorkspaceInternalName("a.dim.internal")).toBe("a.dim.internal");
  for (const bad of ["npm.cache.example.com", "Npm.Cache.dim.internal", "-npm.dim.internal", "npm-.dim.internal",
    "npm..cache.dim.internal", ".dim.internal", "dim.internal", "npm_cache.dim.internal", `${"a".repeat(250)}.dim.internal`, ""]) {
    expect(() => validateWorkspaceInternalName(bad)).toThrow(/invalid workspace internal name/);
  }
});

it("normalizes a bare http origin and rejects credentials, paths, query or non-http schemes", () => {
  expect(validateWorkspaceUpstream("http://127.0.0.1:4873/")).toBe("http://127.0.0.1:4873/");
  expect(validateWorkspaceUpstream("http://127.0.0.1:4873")).toBe("http://127.0.0.1:4873/");
  for (const bad of ["https://127.0.0.1:4873/", "http://user:pass@127.0.0.1:4873/", "http://127.0.0.1:4873/path",
    "http://127.0.0.1:4873/?x=1", "http://127.0.0.1:4873/#frag", "http://127.0.0.1/", "not-a-url", "ftp://127.0.0.1:21/"]) {
    expect(() => validateWorkspaceUpstream(bad)).toThrow(/invalid workspace name upstream/);
  }
});

it("validates both fields of a registration together", () => {
  expect(validateNameRegistration({ name: "npm.cache.dim.internal", upstream: "http://127.0.0.1:4873" }))
    .toEqual({ name: "npm.cache.dim.internal", upstream: "http://127.0.0.1:4873/" });
  expect(() => validateNameRegistration({ name: "npm.cache.example.com", upstream: "http://127.0.0.1:4873" })).toThrow();
  expect(() => validateNameRegistration({ name: "npm.cache.dim.internal", upstream: "http://127.0.0.1:4873/x" })).toThrow();
});
