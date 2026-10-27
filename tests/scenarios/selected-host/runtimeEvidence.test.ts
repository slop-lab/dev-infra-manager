import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner, WorkspaceService, WorkspaceStore, type WorkspaceRuntime } from "@slop-lab/dim-host-core/workspace";
import { workspaceDiscovery } from "../../../packages/host/core/src/application/workspace-discovery.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";
import { parseLlmChannelEvidence, parseSshHostKey, parseWorkspaceDiscoveryEvidence } from "./runtimeEvidence.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("selected-host runtime evidence", () => {
  it("Given a guest probe result, when parsed, then only an actual shared-channel HTTP response is accepted", () => {
    expect(parseLlmChannelEvidence(JSON.stringify({ schemaVersion: 1,
      endpoint: "http://127.0.0.1:19420/services/llm-router", status: 200, modelCount: 2 })))
      .toEqual({ endpoint: "http://127.0.0.1:19420/services/llm-router", status: 200, modelCount: 2 });
    expect(() => parseLlmChannelEvidence(JSON.stringify({ schemaVersion: 1,
      endpoint: "http://172.17.0.1:8319", status: 200, modelCount: 2 }))).toThrow(/shared service channel/);
    expect(() => parseLlmChannelEvidence(JSON.stringify({ schemaVersion: 1,
      endpoint: "http://127.0.0.1:19420/services/llm-router", status: 503, modelCount: 0 }))).toThrow(/HTTP/);
  });

  it("Given SSH setup output, when parsed, then a stable Ed25519 host key can be compared across recreation", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISelectedHostRuntimeKey";
    expect(parseSshHostKey(`${key}\n`)).toBe(key);
    expect(() => parseSshHostKey("warning: ready\n")).toThrow(/host key/);
  });

  it("Given live generic discovery, when parsed, then it proves this ordinary workspace and an actionable KVM block", () => {
    const input = { workspaceId: "c946b18f-08bb-4f33-a06d-ea2d4de18d74",
      workspaceName: "dim-smoke-run-123", workspaceSourceSha: "b".repeat(40),
      requiredPlugins: ["native-git", "host-llm-router", "kvm"] };
    const discovery = { schemaVersion: 1,
      workspace: { id: input.workspaceId, name: input.workspaceName, runtime: "container", phase: "running",
        source: { commit: input.workspaceSourceSha } },
      freshness: { bridgeGeneration: "c".repeat(64) },
      pluginSet: input.requiredPlugins,
      services: [{ owner: "core", name: "workspace" }, { owner: "native-git", name: "native-git" },
        { owner: "host-llm-router", name: "llm-router" }],
      capabilities: ["direct-access", "vm-fd-verification"].map((name) => ({ owner: "kvm", name,
        state: "blocked", access: { kind: "none" }, reason: { code: "runtime-grant-required", message: "Create a separate container-kvm workspace" } })) };

    expect(parseWorkspaceDiscoveryEvidence(JSON.stringify(discovery), input)).toEqual({ generation: "c".repeat(64) });
    expect(() => parseWorkspaceDiscoveryEvidence(JSON.stringify({ ...discovery,
      capabilities: [{ ...discovery.capabilities[0], state: "available", access: { kind: "external" } }] }), input))
      .toThrow(/container-kvm/);
    expect(() => parseWorkspaceDiscoveryEvidence(JSON.stringify({ ...discovery,
      workspace: { ...discovery.workspace, id: "00000000-0000-4000-8000-000000000000" } }), input)).toThrow(/identity/);
    expect(() => parseWorkspaceDiscoveryEvidence(JSON.stringify({ ...discovery,
      freshness: undefined, bridge: { generation: "c".repeat(64) } }), input)).toThrow(/freshness/);
    const withoutKvm = { ...discovery, pluginSet: ["native-git", "host-llm-router"], capabilities: [] };
    expect(parseWorkspaceDiscoveryEvidence(JSON.stringify(withoutKvm), { ...input,
      requiredPlugins: ["native-git", "host-llm-router"] })).toEqual({ generation: "c".repeat(64) });
    expect(() => parseWorkspaceDiscoveryEvidence(JSON.stringify(withoutKvm), input)).toThrow(/required plugin kvm/);
  });

  it("parses the current output produced by workspaceDiscovery rather than a handwritten legacy projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-selected-discovery-contract-"));
    vi.stubEnv("DIM_PLUGIN_HOME", join(root, "plugins"));
    const runtime: WorkspaceRuntime = { async inspect() { return { running: true }; }, async create() {}, async seed() {},
      async start() {}, async stop() {}, async remove() {}, async updateResources() { return { recreated: false }; },
      async exec() { return 0; }, async connect() { return 0; } };
    const store = new WorkspaceStore(root), runner = new ProcessRunner();
    const service = new WorkspaceService(store, runtime, async () => { throw new Error("source acquisition is not part of discovery"); });
    const record = workspaceRecord("dim-smoke-contract"); await store.write(record);
    try {
      const output = await workspaceDiscovery({ workspace: record, plugins: [], delivery: "online",
        context: { generation: "d".repeat(64), runtime, service, store, stateRoot: root,
          runner, cleanupRunner: runner, signal: AbortSignal.timeout(5_000) } });
      expect(parseWorkspaceDiscoveryEvidence(JSON.stringify(output), { workspaceId: record.id,
        workspaceName: record.name, workspaceSourceSha: record.source.commit, requiredPlugins: [] }))
        .toEqual({ generation: "d".repeat(64) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
