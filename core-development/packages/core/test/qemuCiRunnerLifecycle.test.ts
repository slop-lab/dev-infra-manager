import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ciRunner from "../../../../core/packages/core/src/ciRunner.js";
import {
  ciRunnerQemuDispatchVolumeName,
  ciRunnerQemuRunnerName,
  ciRunnerQemuSupervisorName,
  ciRunnerQemuVolumeName
} from "../../../../core/packages/core/src/ciRunner.js";
import type {
  QemuCiRunnerSupervisorLaunchPlan,
  QemuCiRunnerVolumeDeletionPlan
} from "../../../../core/packages/core/src/qemuCiRunnerLifecycle.js";
import {
  ciRunnerQemuProjectCacheVolumeName,
  ciRunnerQemuSupervisorLaunchArgs,
  ciRunnerQemuVolumeDeletionNames
} from "../../../../core/packages/core/src/qemuCiRunnerLifecycle.js";
import {
  ciRunnerQemuCommonCacheVolumeName,
  QEMU_CI_COMMON_MOUNT,
  QEMU_CI_NO_HOOK_DIGEST,
  QEMU_CI_PROJECT_MOUNT
} from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import type { PreparedQemuProjectHook } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";

const commonImageKey = "a".repeat(64);
const projectImageKey = "b".repeat(64);
const projectCacheMount = "/var/lib/dim-qemu-ci-project-cache";
const hookProvenance = {
  sourceRef: "refs/heads/main",
  sourceCommit: "c".repeat(40)
};

function launchPlan(projectHook: PreparedQemuProjectHook): QemuCiRunnerSupervisorLaunchPlan {
  return {
    record: { projectName: "example", projectId: "project-id", name: "kvm-1" },
    executor: {
      kind: "qemu",
      phase: "ready",
      supervisorName: "dim-ci-example-kvm-1-qemu-supervisor",
      volumeName: "dim-ci-example-kvm-1-qemu-data",
      image: `sha256:${"e".repeat(64)}`,
      projectHook: {
        sourceRef: projectHook.sourceRef,
        sourceCommit: projectHook.sourceCommit,
        kind: projectHook.kind,
        digest: projectHook.digest
      },
      resources: { cpus: "6", memory: "12GiB" },
      inheritsResources: false,
      labels: ["dim-container-integration", "dim-qemu"],
      jobImage: `gitea/runner-images@sha256:${"d".repeat(64)}`,
      updatedAt: "2026-09-12T00:00:00.000Z"
    },
    registration: { instanceUrl: "http://coordinator", token: "registration-token" },
    authorization: "Bearer webhook-secret",
    kvmGroupId: () => 108,
    commonImageKey,
    projectImageKey,
    projectHook
  };
}

function deletionPlan(remainingCapacityNames: readonly string[]): QemuCiRunnerVolumeDeletionPlan {
  return { project: "example", projectId: "project-id", capacityName: "kvm-1", remainingCapacityNames };
}

describe("QEMU CI runner layered image lifecycle", () => {
  it("uses one host-scoped common cache volume independently of Project", () => {
    // Given: two distinct Projects with independent image keys.
    const projects = ["example", "other"];

    // When: the common and Project cache volume names are derived.
    const volumes = projects.map(() => ciRunnerQemuCommonCacheVolumeName());

    // Then: the common cache is host-scoped and Project-independent.
    expect(volumes).toEqual(["dim-ci-qemu-common-cache", "dim-ci-qemu-common-cache"]);
  });

  it("derives distinct Project-owned cache volumes", () => {
    // Given: two distinct Projects.
    const firstProject = "example";
    const secondProject = "other";

    // When: each Project cache volume name is derived.
    const firstProjectVolume = ciRunnerQemuProjectCacheVolumeName(firstProject);
    const secondProjectVolume = ciRunnerQemuProjectCacheVolumeName(secondProject);

    // Then: each Project receives its own cache volume.
    expect(firstProjectVolume).toMatch(/^dim-ci-example-qemu-cache-[0-9a-f]{16}$/);
    expect(secondProjectVolume).toMatch(/^dim-ci-other-qemu-cache-[0-9a-f]{16}$/);
    expect(firstProjectVolume).not.toBe(secondProjectVolume);
  });

  it("bounds long generated names and preserves full-input identity in a hash suffix", () => {
    // Given: valid Projects share the prefix that an unsafe 63-character truncation would retain.
    const firstProject = `${"a".repeat(47)}b`;
    const secondProject = `${"a".repeat(47)}c`;
    const capacity = "capacity";

    // When: DIM derives every Project and capacity resource name.
    const firstNames = [
      ciRunnerQemuProjectCacheVolumeName(firstProject),
      ciRunnerQemuDispatchVolumeName(firstProject),
      ciRunnerQemuVolumeName(firstProject, capacity),
      ciRunnerQemuRunnerName(firstProject, capacity),
      ciRunnerQemuSupervisorName(firstProject, capacity)
    ];
    const secondNames = [
      ciRunnerQemuProjectCacheVolumeName(secondProject),
      ciRunnerQemuDispatchVolumeName(secondProject),
      ciRunnerQemuVolumeName(secondProject, capacity),
      ciRunnerQemuRunnerName(secondProject, capacity),
      ciRunnerQemuSupervisorName(secondProject, capacity)
    ];

    // Then: all names are bounded and the colliding prefixes still produce distinct identities.
    expect(firstNames.every((name) => name.length <= 63)).toBe(true);
    expect(secondNames.every((name) => name.length <= 63)).toBe(true);
    expect(firstNames).not.toEqual(secondNames);
    expect(firstNames.every((name) => /-[0-9a-f]{16}$/.test(name))).toBe(true);
  });

  it("replaces the ambiguous Project cache volume helper without a compatibility alias", () => {
    // Given: the lifecycle module exposes the Project-owned cache helper.
    const volume = ciRunnerQemuProjectCacheVolumeName;

    // When: the legacy CI runner module's public names are inspected.
    const legacyModule = ciRunner;

    // Then: consumers cannot keep using the ambiguous cache-volume name.
    expect(volume).toBeTypeOf("function");
    expect(legacyModule).not.toHaveProperty("ciRunnerQemuCacheVolumeName");
  });

  it("mounts exact shared and Project volumes and exports complete image and hook provenance", () => {
    // Given: an absent Project hook and distinct complete common and Project keys.
    const plan = launchPlan({ ...hookProvenance, kind: "absent", path: "/state/noop/cache.bash", digest: QEMU_CI_NO_HOOK_DIGEST });

    // When: the supervisor launch arguments are planned.
    const args = ciRunnerQemuSupervisorLaunchArgs(plan);

    // Then: the trusted supervisor receives only its data, dispatch, cache volumes, exact hook artifact, and no host socket.
    expect(commonImageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(projectImageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(args).toEqual(expect.arrayContaining([
      `type=volume,source=${plan.executor.volumeName},target=/var/lib/dim-qemu-ci`,
      `type=volume,source=${ciRunnerQemuDispatchVolumeName(plan.record.projectName)},target=/var/lib/dim-qemu-ci-dispatch`,
      `type=volume,source=${ciRunnerQemuCommonCacheVolumeName()},target=${QEMU_CI_COMMON_MOUNT}`,
      `type=volume,source=${ciRunnerQemuProjectCacheVolumeName(plan.record.projectName)},target=${projectCacheMount}`,
      `DIM_QEMU_CI_COMMON_IMAGE_KEY=${commonImageKey}`,
      `DIM_QEMU_CI_PROJECT_IMAGE_KEY=${projectImageKey}`,
      "DIM_QEMU_CI_PROJECT_HOOK_KIND=absent",
      `DIM_QEMU_CI_PROJECT_HOOK_DIGEST=${QEMU_CI_NO_HOOK_DIGEST}`,
      `DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF=${hookProvenance.sourceRef}`,
      `DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT=${hookProvenance.sourceCommit}`,
      `DIM_QEMU_CI_JOB_IMAGE=gitea/runner-images@sha256:${"d".repeat(64)}`,
      "DIM_QEMU_CI_LABELS=dim-container-integration,dim-qemu",
      "GITEA_INSTANCE_URL=http://coordinator",
      "GITEA_RUNNER_REGISTRATION_TOKEN=registration-token",
      `GITEA_RUNNER_NAME=${ciRunnerQemuRunnerName(plan.record.projectName, plan.record.name)}`,
      "DIM_CI_REGISTRY_CACHE_UPSTREAM=dim-registry-cache:5000",
      "DIM_QEMU_CI_CAPACITY=kvm-1",
      "DIM_QEMU_CI_CPUS=6",
      "DIM_QEMU_CI_MEMORY_MB=12288",
      "DIM_QEMU_WEBHOOK_AUTHORIZATION=Bearer webhook-secret",
      "dim.managed=true",
      "dim.owner=dim",
      "dim.project=example",
      "dim.project-id=project-id",
      "dim.capacity=kvm-1",
      "dim.executor=qemu",
      "dim.resource=ci-qemu-supervisor",
      "dim.kind=container"
    ]));
    expect(args.find((argument) => argument.startsWith("dim.digest="))).toMatch(/^dim\.digest=[0-9a-f]{64}$/);
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args).toContain(`type=bind,source=${plan.projectHook.path},target=${QEMU_CI_PROJECT_MOUNT}/cache.bash,readonly`);
    expect(args.at(-1)).toBe(`sha256:${"e".repeat(64)}`);
  });

  it("binds a present immutable hook read-only at the Project hook path", () => {
    // Given: a reviewed immutable hook staged by its full digest.
    const hook: PreparedQemuProjectHook = {
      ...hookProvenance,
      kind: "present",
      path: "/state/assets/qemu-ci-projects/project-id/hooks/".concat("c".repeat(64), "/cache.bash"),
      digest: "c".repeat(64)
    };

    // When: the supervisor launch arguments are planned.
    const args = ciRunnerQemuSupervisorLaunchArgs(launchPlan(hook));

    // Then: the hook is the sole bind mount and is read-only.
    expect(args).toContain(`type=bind,source=${hook.path},target=${QEMU_CI_PROJECT_MOUNT}/cache.bash,readonly`);
    expect(args.filter((argument) => argument.startsWith("type=bind"))).toEqual([
      `type=bind,source=${hook.path},target=${QEMU_CI_PROJECT_MOUNT}/cache.bash,readonly`
    ]);
    expect(args).toContain("DIM_QEMU_CI_PROJECT_HOOK_KIND=present");
    expect(args).toContain(`DIM_QEMU_CI_PROJECT_HOOK_DIGEST=${hook.digest}`);
  });

  it("routes shared scheduling without a local dispatch volume and makes runner names host-unique", () => {
    // Given
    const base = launchPlan({ ...hookProvenance, kind: "absent", path: "/state/noop/cache.bash", digest: QEMU_CI_NO_HOOK_DIGEST });
    const scheduler = {
      projectId: "project-id", hostId: "host-a",
      controllerEndpoint: "https://scheduler-control.example",
      supervisorEndpoint: "https://scheduler-supervisor.example",
      webhookUrl: "https://scheduler.example/v1/webhooks/project-id/workflow-job",
      apiToken: "api-token", webhookToken: "webhook-token"
    };

    // When
    const args = ciRunnerQemuSupervisorLaunchArgs({ ...base, scheduler });

    // Then
    expect(args).toEqual(expect.arrayContaining([
      "DIM_QEMU_SCHEDULER_ENDPOINT=https://scheduler-supervisor.example",
      "DIM_QEMU_SCHEDULER_PROJECT_ID=project-id",
      "DIM_QEMU_SCHEDULER_HOST_ID=host-a",
      "DIM_QEMU_SCHEDULER_TOKEN=api-token",
      "DIM_QEMU_WEBHOOK_AUTHORIZATION=Bearer webhook-secret",
      `GITEA_RUNNER_NAME=${ciRunnerQemuRunnerName("example", "kvm-1", "host-a")}`
    ]));
    expect(args.join(" ")).not.toContain("dim-qemu-ci-dispatch");
    expect(ciRunnerQemuRunnerName("example", "kvm-1", "host-a")).not.toBe(ciRunnerQemuRunnerName("example", "kvm-1", "host-b"));
  });

  it("rejects incomplete image keys before building supervisor arguments", () => {
    // Given: a launch plan with a truncated common image key.
    const plan = { ...launchPlan({ ...hookProvenance, kind: "absent", path: "/state/noop/cache.bash", digest: QEMU_CI_NO_HOOK_DIGEST }), commonImageKey: "a".repeat(16) };

    // When: supervisor launch arguments are planned.
    const launch = () => ciRunnerQemuSupervisorLaunchArgs(plan);

    // Then: no Docker arguments are returned for an incomplete identity.
    expect(launch).toThrow(/common image key.*lowercase SHA-256/i);
  });

  it("rejects a mutable supervisor image before building Docker arguments", () => {
    const plan = launchPlan({ ...hookProvenance, kind: "absent", path: "/state/noop/cache.bash", digest: QEMU_CI_NO_HOOK_DIGEST });

    const launch = () => ciRunnerQemuSupervisorLaunchArgs({
      ...plan,
      executor: { ...plan.executor, image: "dim-qemu-ci-supervisor:0.9" }
    });

    expect(launch).toThrow(/supervisor image.*image ID/i);
  });

  it("rejects a staged artifact from a different commit than runner state", () => {
    // Given
    const hook: PreparedQemuProjectHook = {
      ...hookProvenance,
      kind: "present",
      path: "/state/hook/cache.bash",
      digest: "d".repeat(64)
    };
    const plan = launchPlan(hook);
    const executor = { ...plan.executor, projectHook: { ...plan.executor.projectHook, sourceCommit: "e".repeat(40) } };

    // When
    const launch = () => ciRunnerQemuSupervisorLaunchArgs({ ...plan, executor });

    // Then
    expect(launch).toThrow(/does not match runner state provenance/);
  });

  it("persists exact protected-root hook provenance in QEMU runner state", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-qemu-runner-state-"));
    const state = new LifecycleState(root);
    const projectHook = { ...hookProvenance, kind: "present" as const, digest: "b".repeat(64) };
    const executor = { ...launchPlan({ ...projectHook, path: "/state/hook/cache.bash" }).executor, projectHook };
    const record = {
      schemaVersion: 8,
      name: "kvm-1",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea",
      config: { sourceRef: "refs/heads/main", sourceCommit: "c".repeat(40), configDigest: "d".repeat(64) },
      executor,
      createdAt: "now",
      updatedAt: "now"
    } satisfies CiRunnerRecord;

    try {
      // When
      await state.writeCiRunner(record);

      // Then
      expect((await state.readCiRunner("example", "kvm-1")).executor).toMatchObject({ projectHook });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only the removed capacity volume while another Project QEMU capacity remains", () => {
    // Given: one other QEMU capacity remains for the Project.
    const plan = deletionPlan(["kvm-2"]);

    // When: deletion names are planned for the removed capacity.
    const names = ciRunnerQemuVolumeDeletionNames(plan);

    // Then: Project shared volumes and the host common volume survive.
    expect(names).toEqual([ciRunnerQemuVolumeName("example", "kvm-1")]);
    expect(names).not.toContain(ciRunnerQemuCommonCacheVolumeName());
  });

  it("deletes Project shared volumes only after its final QEMU capacity", () => {
    // Given: the removed capacity is the Project's final QEMU capacity.
    const plan = deletionPlan([]);

    // When: deletion names are planned for the final capacity.
    const names = ciRunnerQemuVolumeDeletionNames(plan);

    // Then: only Project-owned data, dispatch, and cache volumes are removed.
    expect(names).toEqual([
      ciRunnerQemuVolumeName("example", "kvm-1"),
      ciRunnerQemuDispatchVolumeName("example"),
      ciRunnerQemuProjectCacheVolumeName("example")
    ]);
    expect(names).not.toContain(ciRunnerQemuCommonCacheVolumeName());
  });
});
