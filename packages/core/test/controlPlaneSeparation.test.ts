import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalAuthority,
  ProtocolError,
  SshBrokerTransport,
  WorkloadRegistryExecutor,
  executeRemoteProposal,
  parseScheduleProposal,
  treeDigest,
  type ApprovedTree,
  type ScheduleProposal
} from "../../../../core/packages/runtime/src/index.js";

const projectId = "project-1";
const entries = [
  { path: "src/index.ts", kind: "file", mode: "100644", digest: "a".repeat(64) },
  { path: "test/index.test.ts", kind: "file", mode: "100644", digest: "b".repeat(64) }
] as const;

function proposal(overrides: Partial<ScheduleProposal> = {}): ScheduleProposal {
  return {
    schemaVersion: 1,
    requestId: "request-1",
    projectId,
    workloadId: "unit-tests",
    tree: { schemaVersion: 1, digest: treeDigest(entries), entries },
    capabilities: ["nested-containers"],
    ...overrides
  };
}

describe("control-plane separation", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("rejects broker fields that could select host commands", () => {
    const malicious = { ...proposal(), hostCommand: ["sh", "-c", "id"] };

    expect(() => parseScheduleProposal(malicious)).toThrow(ProtocolError);
  });

  it("keeps provider code outside the local core and CLI dependency closure", async () => {
    const repository = path.resolve(import.meta.dirname, "../../../../core");
    const runtimeManifest = JSON.parse(await readFile(path.join(repository, "packages/runtime/package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    const cliManifest = JSON.parse(await readFile(path.join(repository, "packages/cli/package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const sources = await readdir(path.join(repository, "packages/runtime/src"));
    const sourceText = (await Promise.all(sources.filter((name) => name.endsWith(".ts"))
      .map((name) => readFile(path.join(repository, "packages/runtime/src", name), "utf8")))).join("\n");

    expect(runtimeManifest.dependencies ?? {}).toEqual({});
    expect(cliManifest.dependencies).toEqual({ "@slop-lab/dim-core": "workspace:0.9.0", commander: "14.0.0" });
    expect(sourceText.toLowerCase()).not.toContain("gitea");
    expect(sourceText).not.toContain("act_runner");
  });

  it("admits only an explicitly approved full tree and capability ceiling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-approval-"));
    cleanup.push(root);
    const authority = new ApprovalAuthority(root);
    const approved: ApprovedTree = {
      schemaVersion: 1,
      projectId,
      treeDigest: treeDigest(entries),
      pathPatterns: ["src/**", "test/**"],
      capabilityCeiling: ["nested-containers"],
      approvedAt: "2026-09-23T00:00:00.000Z",
      approvedBy: "local-operator"
    };

    await authority.approve(approved);
    const result = await authority.admit(proposal());

    expect(result).toEqual({ projectId, workloadId: "unit-tests", treeDigest: approved.treeDigest });
  });

  it.each([
    ["symlink", [{ path: "src/link", kind: "symlink", mode: "120000", digest: "c".repeat(64) }]],
    ["gitlink", [{ path: "vendor/submodule", kind: "gitlink", mode: "160000", digest: "d".repeat(64) }]],
    ["gitmodules", [{ path: ".gitmodules", kind: "file", mode: "100644", digest: "e".repeat(64) }]]
  ] as const)("rejects %s trees", async (_name, unsafeEntries) => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-approval-"));
    cleanup.push(root);
    const authority = new ApprovalAuthority(root);
    await authority.approve({
      schemaVersion: 1,
      projectId,
      treeDigest: treeDigest(unsafeEntries),
      pathPatterns: ["**"],
      capabilityCeiling: [],
      approvedAt: "2026-09-23T00:00:00.000Z",
      approvedBy: "local-operator"
    });

    await expect(authority.admit(proposal({
      tree: { schemaVersion: 1, digest: treeDigest(unsafeEntries), entries: unsafeEntries },
      capabilities: []
    }))).rejects.toThrow(ProtocolError);
  });

  it("rejects capability widening and obsolete approval state with export guidance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-approval-"));
    cleanup.push(root);
    const authority = new ApprovalAuthority(root);
    await authority.approve({
      schemaVersion: 1,
      projectId,
      treeDigest: treeDigest(entries),
      pathPatterns: ["**"],
      capabilityCeiling: [],
      approvedAt: "2026-09-23T00:00:00.000Z",
      approvedBy: "local-operator"
    });
    await expect(authority.admit(proposal())).rejects.toThrow("capability ceiling");
    await writeFile(path.join(root, `${projectId}.json`), JSON.stringify({ schemaVersion: 0, projectId }));

    await expect(authority.admit(proposal({ capabilities: [] }))).rejects.toThrow("export needed data");
  });

  it("uses pinned non-forwarding SSH and executes only a registered workload ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-ssh-"));
    cleanup.push(root);
    const argsPath = path.join(root, "args.json");
    const sshPath = path.join(root, "ssh-fixture.mjs");
    await writeFile(sshPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(proposal())}\n`)});`
    ].join("\n"), { mode: 0o700 });
    const authority = new ApprovalAuthority(path.join(root, "approvals"));
    await authority.approve({
      schemaVersion: 1,
      projectId,
      treeDigest: treeDigest(entries),
      pathPatterns: ["**"],
      capabilityCeiling: ["nested-containers"],
      approvedAt: "2026-09-23T00:00:00.000Z",
      approvedBy: "local-operator"
    });
    const executed: string[] = [];
    const executor = new WorkloadRegistryExecutor(new Map([
      ["unit-tests", async () => { executed.push("unit-tests"); return { exitCode: 0 }; }]
    ]));
    const transport = new SshBrokerTransport({
      executable: sshPath,
      host: "broker.example",
      user: "dim-broker",
      port: 2222,
      identityFile: "/keys/id_ed25519",
      knownHostsFile: "/keys/known_hosts",
      timeoutMs: 5_000,
      maxResponseBytes: 65_536
    });

    const result = await executeRemoteProposal(
      transport,
      authority,
      executor,
      { schemaVersion: 1, requestId: "request-1", projectId }
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(executed).toEqual(["unit-tests"]);
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("-T");
    expect(args).not.toContain("-A");
    expect(args).not.toContain("-L");
    expect(args).not.toContain("-R");
    expect(args.at(-1)).toBe("dim-control-plane broker stdio");
  });
});
