import assert from "node:assert/strict";
import test from "node:test";
import { matchesGitCredentialScope } from "../../../../core/packages/cli/src/gitCredentialScope.js";

test("external Git credentials match the configured scheme, authority, and base path", () => {
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "git.example:8443",
    path: "gitea/dim-acme/root.git"
  }, "https://git.example:8443/gitea"), true);
});

test("external Git credentials reject another authority or path", () => {
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "other.example",
    path: "gitea/dim-acme/root.git"
  }, "https://git.example/gitea"), false);
  assert.equal(matchesGitCredentialScope({
    protocol: "https",
    host: "git.example",
    path: "unrelated/root.git"
  }, "https://git.example/gitea"), false);
});
