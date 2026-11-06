import { describe, expect, it } from "vitest";
import { OperatorInputError, ownedPartialWorkspace, ownedWorkspaceName, smokeWorkspaceName, parseOperatorArguments, parseSmokeConfiguration } from "./config.js";
import { workspaceName } from "../../../packages/host/core/src/workspace/store.js";

const sha = "a".repeat(40);
const workspaceSourceSha = "b".repeat(40);
const configuration = {
  schemaVersion: 1,
  installedSourceSha: sha,
  hosts: [{
    name: "devbox",
    workspace: "dim-smoke-daily-devbox",
    source: "dim://dim-smoke-project",
    workspaceSourceSha,
    expectedHostVersion: "0.10.0-local-reviewed",
    requiredPlugins: ["agent-tools", "host-llm-router", "external-urls", "native-git"],
    ingress: "shared",
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFreshSelectedHostSmokeKey dim-smoke@example.invalid",
    llm: { configFile: "/private/llm/gateway.json", project: "smoke", route: "default", provider: "dim-responses", model: "reviewed-model", operatorConnectionFile: "/private/llm/read-only.json" }
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
    const parsed = parseSmokeConfiguration(configuration);
    expect(parsed.installedSourceSha).toBe(sha);
    expect(parsed.hosts[0]).toMatchObject({ workspaceSourceSha,
      requiredPlugins: ["agent-tools", "host-llm-router", "external-urls", "native-git"] });
  });

  it("Given installed provenance and a different fresh source commit, when parsed, then neither SHA is substituted for the other", () => {
    const parsed = parseSmokeConfiguration(configuration);
    expect(parsed.installedSourceSha).not.toBe(parsed.hosts[0]?.workspaceSourceSha);
  });

  it("accepts an ordinary reviewed repository without Native Git or CI plugins", () => {
    const ordinary = structuredClone(configuration);
    ordinary.hosts[0]!.source = "/srv/disposable/dim-smoke-repo";
    ordinary.hosts[0]!.requiredPlugins = ["agent-tools", "host-llm-router", "external-urls"];
    expect(parseSmokeConfiguration(ordinary).hosts[0]?.source).toBe("/srv/disposable/dim-smoke-repo");
  });

  it("requires immutable images for isolated updates before any runtime operation", () => {
    const isolatedUpdate = { beforeFacade: "/old/dim", beforeBundle: "/old/bundle", afterFacade: "/new/dim", afterBundle: "/new/bundle", image: "latest" };
    expect(() => parseSmokeConfiguration({ ...configuration, isolatedUpdate })).toThrow(/isolatedUpdate/);
    expect(parseSmokeConfiguration({ ...configuration, isolatedUpdate: { ...isolatedUpdate, image: `sha256:${"a".repeat(64)}` } }).isolatedUpdate?.beforeFacade).toBe("/old/dim");
  });

  it("rejects inline repository credentials and implicit relative host paths", () => {
    for (const source of ["./repo", "https://operator:secret@example.invalid/repo.git"]) {
      const ordinary = structuredClone(configuration); ordinary.hosts[0]!.source = source;
      expect(() => parseSmokeConfiguration(ordinary)).toThrow(/source/);
    }
  });

  it.each(["workspaceSourceSha", "sshPublicKey"] as const)(
    "Given a profile missing %s, when parsed, then the live check cannot silently reuse another input",
    (field) => {
      const invalid = structuredClone(configuration);
      const host = invalid.hosts[0];
      if (host === undefined) throw new Error("configuration fixture has no host");
      delete host[field];
      expect(() => parseSmokeConfiguration(invalid)).toThrow(field);
    }
  );

  it("Given a missing required plugin, when parsed, then the profile fails instead of silently skipping a step", () => {
    const invalid = structuredClone(configuration);
    invalid.hosts[0]!.requiredPlugins = ["agent-tools", "external-urls"];
    expect(() => parseSmokeConfiguration(invalid)).toThrow(/host-llm-router/);
  });

  it("binds monitor identity at runtime and rejects a configured foreign parent", () => {
    const hosts = configuration.hosts.map((host) => ({ ...host, monitor: { maxSessions: 12 } }));
    expect(parseSmokeConfiguration({ ...configuration, hosts }).hosts[0]?.monitor).toMatchObject({ maxSessions: 12 });
    expect(() => parseSmokeConfiguration({ ...configuration, hosts: hosts.map((host) => ({ ...host, monitor: { parentSessionId: "ses_FOREIGN" } })) })).toThrow(/parentSessionId/);
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
