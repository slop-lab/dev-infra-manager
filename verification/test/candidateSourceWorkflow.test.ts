import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");
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
  readonly steps: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly permissions: Readonly<Record<string, string>>;
};

async function readWorkflow(name: string): Promise<{ readonly source: string; readonly workflow: Workflow }> {
  const source = await readFile(resolve(workspaceRoot, `.gitea/workflows/${name}.yml`), "utf8");
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
        `node verification/scripts/candidate-source-evidence.mjs "$DIM_EXPECTED_CANDIDATE_SHA" ${artifactPath}`,
      ),
    }),
    expect.objectContaining({
      if: "always()",
      uses: "actions/upload-artifact@ff15f0306b3f739f7b6fd43fb5d26cd321bd4de5",
      with: expect.objectContaining({ path: artifactPath, "if-no-files-found": "error" }),
    }),
  ]));
}

describe("candidate source workflows", () => {
  it("binds source verification to the event commit and uploads only its exact-tree evidence", async () => {
    // Given
    const { source, workflow } = await readWorkflow("verify");
    const sourceJob = workflow.jobs.source;
    assert(sourceJob !== undefined);

    // When / Then
    expect(workflow.permissions).toEqual({ contents: "read" });
    expectExactCheckout(sourceJob, "${{ gitea.sha }}");
    expectEvidenceArtifact(sourceJob, "${{ gitea.sha }}");
    expect(sourceJob.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.stringContaining("just verify package-packs") }),
    ]));
    expect(source).not.toMatch(/\.monorepo-candidate|monorepo-candidate|sources\.tsv|overlay/);
  });

  it("binds every release job to the dispatched full commit and rejects a missing evidence artifact", async () => {
    // Given
    const { source, workflow } = await readWorkflow("release-gate");
    const jobs = Object.values(workflow.jobs);

    // When / Then
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expectExactCheckout(job, "${{ inputs.candidate_sha }}");
      expectEvidenceArtifact(job, "${{ inputs.candidate_sha }}");
      expect(job.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          env: expect.objectContaining({ DIM_DISPATCH_SHA: "${{ gitea.sha }}" }),
          run: expect.stringContaining('test "$DIM_EXPECTED_CANDIDATE_SHA" = "$DIM_DISPATCH_SHA"'),
        }),
      ]));
    }
    expect(workflow.jobs["container-integration"]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.stringContaining("just verify package-packs") }),
    ]));
    expect(source).not.toMatch(/\.monorepo-candidate|monorepo-candidate|sources\.tsv|overlay/);
  });

  it("binds hosted backend gates to one exact root commit without split checkouts", async () => {
    // Given
    const { source, workflow } = await readWorkflow("host-backends");
    const hostJob = workflow.jobs.verify;
    assert(hostJob !== undefined);

    // When / Then
    expect(workflow.permissions).toEqual({ contents: "read" });
    expectExactCheckout(hostJob, "${{ inputs.candidate_sha }}");
    expectEvidenceArtifact(hostJob, "${{ inputs.candidate_sha }}");
    expect(source.match(/actions\/checkout@/g)).toHaveLength(1);
    expect(source).not.toMatch(/repository:|path:\s+snapshot|candidate-ref|candidate-repository|development-ref|root-ref|verification-ref/);
    for (const gate of [
      "source",
      "container",
      "integration",
      "kvm",
      "kvm-control",
      "cache-routing-sysbox",
      "cache-routing-kvm",
      "qemu-ci-image-layers-kvm",
    ]) {
      expect(source).toContain(`inputs.gate == '${gate}'`);
    }
  });

  it("dispatches scheduled and manual hosted gates from the immutable event commit", async () => {
    // Given
    const { source, workflow } = await readWorkflow("integration");

    // When / Then
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      "cache-routing-kvm",
      "container",
      "kvm",
      "qemu-ci-image-layers-kvm",
    ]);
    expect(source).toContain("schedule:");
    expect(source).toContain("workflow_dispatch:");
    expect(source.match(/candidate_sha: \$\{\{ gitea\.sha \}\}/g)).toHaveLength(4);
    expect(source).not.toMatch(/candidate-ref|candidate-repository|repository:|refs\/heads\/|\|\|\s*'main'/);
  });

  it("has no obsolete candidate assembly entry point in the tracked source layout", async () => {
    // Given
    const obsoletePaths = [
      ".monorepo-candidate/sources.tsv",
      "scripts/build-monorepo-candidate.bash",
      "scripts/monorepo-candidate-assembly.bash",
      "scripts/monorepo-candidate-overlay/verify.yml",
      "verification/scripts/monorepo-candidate-evidence.mjs",
    ];

    // When
    const results = await Promise.allSettled(obsoletePaths.map((path) => access(resolve(workspaceRoot, path))));

    // Then
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });
});
