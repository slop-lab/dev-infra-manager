import { describe, expect, it } from "vitest";
import { OperatorInputError, ownedPartialWorkspace, ownedWorkspaceName, smokeWorkspaceName, parseOperatorArguments, parseSmokeConfiguration } from "./config.js";
import { workspaceName } from "../../../packages/host/core/src/workspace/store.js";

const sha = "a".repeat(40);
const configuration = {
  schemaVersion: 1,
  installedSourceSha: sha,
  hosts: [{
    name: "devbox",
    workspace: "dim-smoke-daily-devbox",
    source: "dim://dim-smoke-project",
    expectedHostVersion: "0.10.0-local-reviewed",
    requiredPlugins: ["agent-tools", "host-llm-router", "external-urls", "native-git"],
    ingress: "shared", llm: { configFile: "/private/llm/gateway.json", project: "smoke", route: "default" }
  }]
};

describe("parseOperatorArguments", () => {
  it("Given an absolute configuration and explicit hosts, when parsed, then no current host can be selected implicitly", () => {
    expect(parseOperatorArguments(["--config", "/tmp/selected-host.json", "--host", "devbox", "--preflight-only"]))
      .toEqual({ configPath: "/tmp/selected-host.json", hosts: ["devbox"], preflightOnly: true, json: false });
  });

  it("Given no explicit host, when parsed, then execution is rejected", () => {
    expect(() => parseOperatorArguments(["--config", "/tmp/selected-host.json"])).toThrow(/--host/);
  });

  it("Given a duplicate host, when parsed, then ambiguous repeated execution is rejected", () => {
    expect(() => parseOperatorArguments(["--config", "/tmp/selected-host.json", "--host", "devbox", "--host", "devbox"]))
      .toThrow(OperatorInputError);
  });
});

describe("parseSmokeConfiguration", () => {
  it("Given a complete host profile, when parsed, then required live capabilities remain mandatory", () => {
    expect(parseSmokeConfiguration(configuration).hosts[0]?.requiredPlugins)
      .toEqual(["agent-tools", "host-llm-router", "external-urls", "native-git"]);
  });

  it("Given a missing required plugin, when parsed, then the profile fails instead of silently skipping a step", () => {
    const invalid = structuredClone(configuration);
    invalid.hosts[0]!.requiredPlugins = ["agent-tools", "external-urls"];
    expect(() => parseSmokeConfiguration(invalid)).toThrow(/host-llm-router/);
  });

  it("Given a workspace outside the smoke namespace, when parsed, then cleanup ownership is rejected", () => {
    const invalid = structuredClone(configuration);
    invalid.hosts[0]!.workspace = "development";
    expect(() => parseSmokeConfiguration(invalid)).toThrow(/dim-smoke-/);
  });
});

describe("ownedWorkspaceName", () => {
  it("Given the selected profile name and learned record, when identity matches, then exact cleanup is authorized", () => {
    expect(ownedWorkspaceName("dim-smoke-daily-devbox", { id: "c946b18f-08bb-4f33-a06d-ea2d4de18d74", name: "dim-smoke-daily-devbox" }))
      .toEqual({ name: "dim-smoke-daily-devbox", id: "c946b18f-08bb-4f33-a06d-ea2d4de18d74" });
  });

  it("Given a mismatched returned name, when ownership is checked, then destructive cleanup is refused", () => {
    expect(() => ownedWorkspaceName("dim-smoke-daily-devbox", { id: "c946b18f-08bb-4f33-a06d-ea2d4de18d74", name: "development" }))
      .toThrow(/ownership/);
  });
});

it("claims only the current run's exact random workspace, Project and valid creation timestamp after partial creation", () => {
  const claim = { name: "dim-smoke-run-123", source: "dim://dim-smoke-project", startedAt: Date.parse("2026-10-26T08:00:00Z") };
  const record = { name: claim.name, id: "c946b18f-08bb-4f33-a06d-ea2d4de18d74", source: { url: `${claim.source}/main` }, createdAt: "2026-10-26T08:00:01Z" };
  expect(ownedPartialWorkspace(claim, record)).toEqual({ name: claim.name, id: record.id });
  expect(() => ownedPartialWorkspace(claim, { ...record, createdAt: "invalid" })).toThrow(/ownership/);
  expect(() => ownedPartialWorkspace(claim, { ...record, source: { url: "dim://other/main" } })).toThrow(/ownership/);
  expect(() => ownedPartialWorkspace(claim, { ...record, createdAt: "2026-10-26T07:00:00Z" })).toThrow(/ownership/);
});

it("keeps unique generated workspace names within the actual DIM lifecycle-name contract", () => {
  const prefix = "dim-smoke-" + "a".repeat(38), first = smokeWorkspaceName(prefix), second = smokeWorkspaceName(prefix);
  expect(workspaceName(first)).toBe(first); expect(first.length).toBeLessThanOrEqual(48); expect(second).not.toBe(first);
});
