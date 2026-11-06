import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const artifactPath = "/tmp/dim-candidate-source-evidence.json";

type WorkflowStep = {
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
};

type WorkflowJob = {
  readonly "runs-on"?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowStep[];
};

type Workflow = {
  readonly on?: { readonly push?: { readonly branches?: readonly string[]; readonly tags?: readonly string[] }; readonly merge_group?: { readonly branches?: readonly string[] }; readonly pull_request?: unknown };
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly permissions: Readonly<Record<string, string>>;
};

async function readWorkflow(name: string): Promise<{ readonly source: string; readonly workflow: Workflow }> {
  const source = await readFile(resolve(workspaceRoot, `.github/workflows/${name}.yml`), "utf8");
  return { source, workflow: parse(source) as Workflow };
}

function expectExactCheckout(job: WorkflowJob, ref: string): void {
  expect(job.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({
      uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      with: { ref, "fetch-depth": 0, "persist-credentials": false },
    }),
  ]));
}

function expectEvidenceArtifact(job: WorkflowJob, expectedCommit: string): void {
  expect(job.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({
      env: expect.objectContaining({ DIM_EXPECTED_CANDIDATE_SHA: expectedCommit }),
      run: expect.stringContaining(
        `node scripts/checks/candidate-source-evidence.mjs "$DIM_EXPECTED_CANDIDATE_SHA" ${artifactPath}`,
      ),
    }),
    expect.objectContaining({
      if: "always()",
      uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      with: expect.objectContaining({ path: artifactPath, "if-no-files-found": "error" }),
    }),
  ]));
}

describe("candidate source workflows", () => {
  it("binds source verification to the event commit and retains source evidence and check logs", async () => {
    // Given
    const { workflow } = await readWorkflow("verify");
    const sourceJob = workflow.jobs.source;
    assert(sourceJob !== undefined);

    // When / Then
    expect(workflow.permissions).toEqual({ contents: "read" });
    expectExactCheckout(sourceJob, "${{ github.sha }}");
    expectEvidenceArtifact(sourceJob, "${{ github.sha }}");
    expect(sourceJob.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: "bash scripts/checks/source-gate-container.bash" }),
    ]));
    expect(sourceJob.steps).toContainEqual(expect.objectContaining({
      if: "always()",
      with: expect.objectContaining({ path: "${{ runner.temp }}/dim-source-checks", "retention-days": 7 }),
    }));
  });

  it("dispatches native ordinary and trusted real-KVM integration lanes", async () => {
    // Given
    const { source, workflow } = await readWorkflow("integration");

    // When / Then
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs).sort()).toEqual(["ordinary", "qemu-kvm", "vm-runtime-acceptance"]);
    expect(source).toContain("workflow_dispatch:");
    expect(source.match(/ref: \$\{\{ github\.sha \}\}/g)).toHaveLength(3);
    expect(source).toContain("just verify native-ordinary-executor-live");
    expect(source).toContain("just verify native-qemu-guest-mechanics-kvm");
    const runtime = workflow.jobs["vm-runtime-acceptance"];
    assert(runtime !== undefined);
    expect(runtime.env).toBeUndefined();
    expect(runtime.steps).toContainEqual(expect.objectContaining({
      env: { DIM_VM_ACCEPTANCE_ROOT: "${{ runner.temp }}/vm-runtime-acceptance" },
      run: "just verify vm-runtime-prepare --run",
    }));
    for (const job of Object.values(workflow.jobs)) {
      expectExactCheckout(job, "${{ github.sha }}");
      const pnpm = job.steps.find((step) => step.uses?.startsWith("pnpm/action-setup@"));
      expect(pnpm).toMatchObject({
        uses: "pnpm/action-setup@7088e561eb65bb68695d245aa206f005ef30921d",
        with: { version: "10.13.1" },
      });
      const install = job.steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
      const build = job.steps.findIndex((step) => step.run === "just build-packages");
      const gate = job.steps.findIndex((step) => step.run?.startsWith("just verify "));
      expect(install).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(install);
      expect(gate).toBeGreaterThan(build);
    }
  });

  it("uses only reviewed existing action commits with supported Node runtimes", async () => {
    // Reviewed upstream action.yml runtimes: checkout v4, upload-artifact
    // v4.6.2, and pnpm/action-setup v4.1.0 all use node20. The artifact v3
    // commit and the nonexistent pnpm commit must not return to either workflow.
    const approved = new Set([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "pnpm/action-setup@7088e561eb65bb68695d245aa206f005ef30921d",
    ]);
    for (const name of ["verify", "integration"]) {
      const { workflow } = await readWorkflow(name);
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.uses === undefined) continue;
          expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
          expect(approved.has(step.uses), step.uses).toBe(true);
        }
      }
    }
  });

  it("requires practical runtime receipts on trusted existing gates without development-push hardware dispatch", async () => {
    const { workflow } = await readWorkflow("examples"), job = workflow.jobs["examples-vm"];
    assert(job !== undefined);
    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(workflow.on?.push?.tags).toEqual(["v*"]);
    expect(workflow.on?.merge_group?.branches).toEqual(["main"]);
    expect(workflow.on?.pull_request).toBeUndefined();
    expect(job["runs-on"]).toBe("dim-native-qemu");
    const runtime = job.steps.findIndex((step) => step.run === "bash scripts/checks/examples-vm-smoke.bash");
    const required = job.steps.findIndex((step) => step.run?.startsWith("node tests/scenarios/selected-host/ci/verifyEvidence.ts"));
    expect(runtime).toBeGreaterThan(-1); expect(required).toBeGreaterThan(runtime);
    expect(job.steps[required]?.if).toBeUndefined();
    expect(job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@")).every((step) => step.with?.["if-no-files-found"] === "error")).toBe(true);
    const contract: unknown = JSON.parse(await readFile(resolve(workspaceRoot, ".github/required-runtime-checks.json"), "utf8"));
    expect(contract).toMatchObject({ requiredChecks: ["examples-vm", "vm-runtime-acceptance"], developmentPushHardwareRuns: false, missingHardwareOrReceipt: "pending-or-failure-never-successful-skip" });
  });

  it("has no obsolete candidate assembly entry point in the tracked source layout", async () => {
    // Given
    const obsoletePaths = [
      ".monorepo-candidate/sources.tsv",
      "scripts/build-monorepo-candidate.bash",
      "scripts/monorepo-candidate-assembly.bash",
      "scripts/monorepo-candidate-overlay/verify.yml",
      "scripts/checks/monorepo-candidate-evidence.mjs",
    ];

    // When
    const results = await Promise.allSettled(obsoletePaths.map((path) => access(resolve(workspaceRoot, path))));

    // Then
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });
});
