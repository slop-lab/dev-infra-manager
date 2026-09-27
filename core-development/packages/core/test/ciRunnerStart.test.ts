import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  options,
  persistedHook,
  type QemuStartContext,
  reconcileWithFixture,
  setUpQemuStartTest,
  StartRunner,
  tearDownQemuStartTest,
  testState
} from "./ciRunnerStartHarness.js";
import { restartCiRunner, startCiRunner } from "../../../../core/packages/core/src/ciRunner.js";

describe("QEMU CI runner stopped start", () => {
  let context: QemuStartContext;

  beforeEach(async () => { context = await setUpQemuStartTest(); });
  afterEach(async () => { await tearDownQemuStartTest(context); });

  it("restores runtime resources after releasing the Project lock without resolving current admission inputs", async () => {
    // Given
    const runner = new StartRunner();

    // When
    await startCiRunner(runner, options, { project: context.record.projectName, name: context.record.name });

    // Then
    expect(testState.events).not.toEqual(expect.arrayContaining([
      "current:root", "current:config", "current:hook", "current:host-image",
      "current:supervisor-image", "current:defaults", "current:probes"
    ]));
    expect(testState.events.indexOf("unlock:project")).toBeLessThan(testState.events.indexOf("runtime:kvm"));
    expect(testState.events.indexOf("runtime:kvm")).toBeLessThan(testState.events.indexOf("persisted:hook"));
    expect(testState.events).toEqual(expect.arrayContaining([
      "runtime:cache", "runtime:volume:ci-qemu-data", "runtime:volume:ci-qemu-dispatch",
      "runtime:volume:ci-qemu-common-cache", "runtime:volume:ci-qemu-project-cache",
      "runtime:remove-webhook", "runtime:remove-registration", "runtime:register", "runtime:launch"
    ]));
  });

  it("preserves schema-8 admission state while using fresh registration, authorization, and persisted image keys", async () => {
    // Given
    const runner = new StartRunner();

    // When
    const started = await startCiRunner(runner, options, { project: context.record.projectName, name: context.record.name });

    // Then
    expect(started.config).toEqual(context.record.config);
    expect(started.executor).toMatchObject({
      kind: "qemu", phase: "ready", supervisorName: context.record.executor.supervisorName,
      volumeName: context.record.executor.volumeName,
      image: context.record.executor.image, projectHook: persistedHook, resources: context.record.executor.resources,
      inheritsResources: context.record.executor.inheritsResources, labels: context.record.executor.labels,
      jobImage: context.record.executor.jobImage
    });
    expect(testState.imageKeyInputs).toEqual([{ projectId: context.record.projectId, hook: persistedHook }]);
    const launch = testState.launches[0] ?? [];
    expect(launch).toContain("GITEA_RUNNER_REGISTRATION_TOKEN=fresh-registration");
    expect(launch).toContain(`DIM_QEMU_CI_JOB_IMAGE=${context.record.executor.jobImage}`);
    const authorization = launch.find((argument) => argument.startsWith("DIM_QEMU_WEBHOOK_AUTHORIZATION="))?.split("=")[1];
    expect(authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(testState.events).toContain(`runtime:webhook:${authorization}`);
    expect(started.provider).toBe("fresh-provider");
  });

  it.each(["create", "start", "restart"] as const)("installs the webhook before replaying queued jobs on %s and publishes ready afterward", async (mode) => {
    // Given
    const runner = new StartRunner();

    // When
    const started = await reconcileWithFixture(mode, runner, context);

    // Then
    expect(testState.events.indexOf("runtime:launch")).toBeLessThan(testState.events.indexOf("runtime:health"));
    expect(testState.events.indexOf("runtime:health")).toBeLessThan(testState.events.findIndex((event) => event.startsWith("runtime:webhook:")));
    expect(testState.events.findIndex((event) => event.startsWith("runtime:webhook:"))).toBeLessThan(testState.events.indexOf("runtime:query-backlog"));
    expect(testState.events.indexOf("runtime:query-backlog")).toBeLessThan(testState.events.indexOf("runtime:replay"));
    const health = testState.dockerCalls.find((call) => call.at(-1) === "http://127.0.0.1:8080/healthz");
    const replay = testState.dockerCalls.find((call) => call.at(-1) === "http://127.0.0.1:8080/workflow-job");
    expect(health).toEqual(expect.arrayContaining(["docker", "exec", "immutable-supervisor-id", "--header", expect.stringMatching(/^Authorization: Bearer /)]));
    expect(replay).toEqual(expect.arrayContaining(["docker", "exec", "immutable-supervisor-id", "--header", "X-Gitea-Event: workflow_job"]));
    expect(replay).toContain(JSON.stringify({ action: "queued", workflow_job: { id: 991, labels: ["persisted-integration", "dim-qemu"] } }));
    expect(health).not.toContain("sh");
    expect(replay).not.toContain("sh");
    expect(started.executor.phase).toBe("ready");
  });

  it.each(["create", "start", "restart"] as const)("retains an error phase when queued-job reconciliation fails on %s", async (mode) => {
    // Given
    const runner = new StartRunner();
    testState.webhookFailures.push(new Error("queued backlog failed"));

    // When / Then
    await expect(reconcileWithFixture(mode, runner, context)).rejects.toThrow("queued backlog failed");
    const persisted = await context.state.readCiRunner(context.record.projectName, context.record.name);
    expect(persisted.executor).toMatchObject({ phase: "error", error: "queued backlog failed" });
  });

  it("keeps restart on full protected-state reconciliation", async () => {
    // Given
    const runner = new StartRunner();

    // When
    const restarted = await restartCiRunner(runner, options, { project: context.record.projectName, name: context.record.name });

    // Then
    expect(testState.events).toEqual(expect.arrayContaining([
      "current:root", "current:config", "current:hook", "current:host-image",
      "current:supervisor-image", "current:defaults", "current:probes"
    ]));
    expect(restarted.config).toEqual(testState.resolvedConfig.provenance);
    expect(restarted.executor).toMatchObject({
      kind: "qemu", phase: "ready", image: `sha256:${"f".repeat(64)}`,
      projectHook: {
        sourceRef: testState.currentHook.sourceRef, sourceCommit: testState.currentHook.sourceCommit,
        kind: testState.currentHook.kind, digest: testState.currentHook.digest
      },
      resources: { cpus: "8", memory: "16GiB" }, inheritsResources: true,
      labels: ["current-integration", "dim-qemu"],
      jobImage: testState.resolvedConfig.config.workloads.integration.image
    });
  });

  it.each([
    ["local to shared", undefined, { projectId: "project-id", hostId: "host-a" }],
    ["shared to local", { projectId: "project-id", hostId: "host-a" }, undefined],
    ["shared host change", { projectId: "project-id", hostId: "host-a" }, { projectId: "project-id", hostId: "host-b" }],
    ["shared Project change", { projectId: "project-id", hostId: "host-a" }, { projectId: "other-project", hostId: "host-a" }]
  ] as const)("rejects a %s before restart reconciliation mutates state", async (_name, persisted, configured) => {
    // Given
    const runner = new StartRunner();
    const executor = { ...context.record.executor, ...(persisted === undefined ? {} : { scheduler: persisted }) };
    await context.state.writeCiRunner({ ...context.record, executor });
    testState.schedulerConnection = configured === undefined ? undefined : {
      ...configured,
      controllerEndpoint: "https://scheduler.example",
      supervisorEndpoint: "https://worker.example",
      webhookUrl: `https://scheduler.example/v1/webhooks/${configured.projectId}/workflow-job`,
      apiToken: "api-token",
      webhookToken: "webhook-token"
    };

    // When / Then
    await expect(restartCiRunner(runner, options, {
      project: context.record.projectName,
      name: context.record.name
    })).rejects.toThrow(/scheduler mode or identity changed/);
    expect(testState.events).not.toEqual(expect.arrayContaining(["current:root", "current:hook", "runtime:remove-container"]));
    expect(testState.dockerCalls).toEqual([]);
    expect((await context.state.readCiRunner(context.record.projectName, context.record.name)).executor).toEqual(executor);
  });
});
