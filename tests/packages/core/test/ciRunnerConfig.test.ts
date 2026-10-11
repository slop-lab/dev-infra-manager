import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ciRunnerLabels,
  loadCiRunnerConfig,
  parseCiRunnerConfigYaml,
  qemuCiRunnerLabels
} from "../../../../core/packages/core/src/ciRunnerConfig.js";
import type { ProtectedRootSnapshot } from "../../../../core/packages/core/src/protectedRootSnapshot.js";

const IMAGE = `gitea/runner-images@sha256:${"a".repeat(64)}`;
const CONFIG = `schemaVersion: 1
workloads:
  ordinary:
    labels: [dim, ubuntu-24.04]
    image: ${IMAGE}
    tools: [bash, git, node]
    capabilities: []
  integration:
    labels: [dim-container-integration]
    image: ${IMAGE}
    tools: [bash, docker, git, node]
    capabilities: [nested-docker]
`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Project CI runner config", () => {
  it("parses explicit ordinary and integration workloads", () => {
    const config = parseCiRunnerConfigYaml(CONFIG);

    expect(config.workloads.ordinary.labels).toEqual(["dim", "ubuntu-24.04"]);
    expect(config.workloads.integration).toMatchObject({
      image: IMAGE,
      capabilities: ["nested-docker"]
    });
  });

  it("rejects mutable images, unknown fields and duplicate entries", () => {
    expect(() => parseCiRunnerConfigYaml(CONFIG.replace(`image: ${IMAGE}`, "image: gitea/runner-images:ubuntu-24.04")))
      .toThrow(/digest-pinned/);
    expect(() => parseCiRunnerConfigYaml(CONFIG.replace("workloads:", "unknown: true\nworkloads:")))
      .toThrow(/unknown field/);
    expect(() => parseCiRunnerConfigYaml(CONFIG.replace("[bash, git, node]", "[bash, git, bash]")))
      .toThrow(/duplicates/);
  });

  it("rejects unknown capabilities and unsafe tool names", () => {
    expect(() => parseCiRunnerConfigYaml(CONFIG.replace("[nested-docker]", "[host-network]")))
      .toThrow(/unknown capability/);
    expect(() => parseCiRunnerConfigYaml(CONFIG.replace("[bash, docker, git, node]", "[bash, ../docker]")))
      .toThrow(/safe executable name/);
  });

  it("separates ordinary Sysbox labels from integration QEMU labels", () => {
    const config = parseCiRunnerConfigYaml(CONFIG);

    expect(ciRunnerLabels(config).split(",")).toEqual([
      `dim:docker://${IMAGE}`,
      `ubuntu-24.04:docker://${IMAGE}`
    ]);
    expect(qemuCiRunnerLabels(config).split(",")).toEqual([
      `dim-container-integration:docker://${IMAGE}`,
      `dim-qemu:docker://${IMAGE}`
    ]);
    expect(`${ciRunnerLabels(config)},${qemuCiRunnerLabels(config)}`).not.toContain(":host");
  });

  it("loads exact bytes and provenance from one protected snapshot", async () => {
    const snapshot = await snapshotFixture(CONFIG);

    const resolved = await loadCiRunnerConfig(snapshot);

    expect(resolved.provenance).toEqual({
      sourceRef: "refs/heads/main",
      sourceCommit: "b".repeat(40),
      configDigest: createHash("sha256").update(CONFIG).digest("hex")
    });
  });

  it("rejects missing config and mutable or symbolic provenance", async () => {
    const missing = await snapshotFixture(undefined);
    const mutableRef = { ...await snapshotFixture(CONFIG), rootRef: "main" };
    const symbolicCommit = { ...await snapshotFixture(CONFIG), rootCommit: "refs/heads/main" };

    await expect(loadCiRunnerConfig(missing)).rejects.toThrow(/runner\.yml.*required/);
    await expect(loadCiRunnerConfig(mutableRef)).rejects.toThrow(/concrete protected branch/);
    await expect(loadCiRunnerConfig(symbolicCommit)).rejects.toThrow(/complete Git commit/);
  });
});

async function snapshotFixture(source: string | undefined): Promise<ProtectedRootSnapshot> {
  const rootSnapshotPath = await mkdtemp(join(tmpdir(), "dim-ci-config-"));
  temporaryDirectories.push(rootSnapshotPath);
  if (source !== undefined) {
    await mkdir(join(rootSnapshotPath, ".dim", "ci"), { recursive: true });
    await writeFile(join(rootSnapshotPath, ".dim", "ci", "runner.yml"), source);
  }
  return {
    project: {
    schemaVersion: 4,
      id: "project-id",
      name: "project",
    gitNamespace: "dim-project",
    giteaOrganizationId: 41,
      phase: "ready",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [],
      createdAt: "now",
      updatedAt: "now"
    },
    repository: {
      alias: "root",
      providerRepoId: "dim-project/root",
      owner: "dim-project",
      hostUrl: "http://host/root.git",
      workspaceUrl: "http://workspace/root.git",
      phase: "ready",
      connections: [],
      protectedPatterns: ["main"],
      protectionPhase: "applied",
      createdAt: "now",
      updatedAt: "now"
    },
    rootRequestedRef: "refs/heads/main",
    rootRef: "refs/heads/main",
    rootCommit: "b".repeat(40),
    rootSnapshotPath
  };
}
