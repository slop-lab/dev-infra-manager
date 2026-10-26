import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CGROUP_READ_COMMAND, kernelLimitsMatch, parseCgroupReadback, type RequestedKernelLimits } from "./cgroup.js";
import { cleanupOwnedWorkspace } from "./cleanup.js";
import { createLifecycleEnvironment, type LifecycleEnvironment } from "./environment.js";
import { inspectContainer, inspectOwnedResource, managedResourceSnapshot, parseWorkspaceList, resourceExists, type WorkspaceView } from "./inspect.js";
import { compareUnrelatedResources, ownedResourceKeys, ownedRuntimeNames } from "./ownership.js";
import { WorkspaceUi } from "./ui.js";

async function workspace(environment: LifecycleEnvironment): Promise<WorkspaceView> {
  const rows = parseWorkspaceList((await environment.cli(["ls", "--json"])).stdout);
  const selected = rows.find((row) => row.name === environment.name);
  if (selected === undefined) throw new TypeError("owned workspace is absent from isolated host state");
  return selected;
}

async function exec(environment: LifecycleEnvironment, command: readonly string[]): Promise<string> {
  return (await environment.cli(["exec", environment.name, "--", ...command])).stdout.trim();
}

async function assertKernelLimits(environment: LifecycleEnvironment, requested: RequestedKernelLimits): Promise<void> {
  const levels = parseCgroupReadback(await exec(environment, CGROUP_READ_COMMAND));
  assert.equal(kernelLimitsMatch(levels, requested), true, "no owned cgroup level exposed the requested kernel limits");
}

function assertLimits(inspection: Awaited<ReturnType<typeof inspectContainer>>, expected: { readonly cpu: string; readonly memory: string; readonly swap: string; readonly pids: string }): void {
  assert.equal(inspection.nanoCpus, expected.cpu);
  assert.equal(inspection.memory, expected.memory);
  assert.equal(inspection.memorySwap, expected.swap);
  assert.equal(inspection.pidsLimit, expected.pids);
}

async function assertOwnedResources(id: string): Promise<void> {
  const names = ownedRuntimeNames(id);
  const container = await inspectContainer(names.container);
  assert.equal(container.runtime, "sysbox-runc");
  assert.deepEqual(container.labels, ["true", id, "container", "10"]);
  await inspectOwnedResource("network", names.network, id, "network");
  for (const role of ["home", "checkout", "docker", "tmp"] as const) await inspectOwnedResource("volume", names[role], id, role);
}

async function preserveMarkers(environment: LifecycleEnvironment): Promise<void> {
  assert.match(await exec(environment, ["git", "rev-parse", "HEAD"]), /^[a-f0-9]{40,64}$/);
  assert.match(await exec(environment, ["cat", "README.md"]), /project-a-initial/);
  await exec(environment, ["sh", "-c", "printf checkout-marker > lifecycle-checkout; printf home-marker > /home/dim/lifecycle-home; printf tmp-marker > /mnt/dim-tmp/lifecycle-tmp"]);
  await exec(environment, ["sh", "-c", "tar -c /bin/busybox /lib/ld-musl-* | docker import - dim-web-lifecycle >/dev/null && docker run --rm dim-web-lifecycle /bin/busybox echo nested-marker"]);
  await exec(environment, ["dim-workspace", "session", "register", "--", "sh", "-c", "printf 'session-resumed\\n' >> /home/dim/lifecycle-session"]);
  await exec(environment, ["dim-workspace", "service", "register", "--name", "web-lifecycle", "--", "sh", "-c", "printf 'service-started\\n' >> /home/dim/lifecycle-service; exec sleep infinity"]);
  await exec(environment, ["dim-workspace", "service", "resume"]);
}

async function assertMarkers(environment: LifecycleEnvironment): Promise<void> {
  assert.equal(await exec(environment, ["cat", "lifecycle-checkout"]), "checkout-marker");
  assert.equal(await exec(environment, ["cat", "/home/dim/lifecycle-home"]), "home-marker");
  assert.equal(await exec(environment, ["cat", "/mnt/dim-tmp/lifecycle-tmp"]), "tmp-marker");
  assert.equal(await exec(environment, ["docker", "run", "--rm", "dim-web-lifecycle", "/bin/busybox", "echo", "nested-retained"]), "nested-retained");
  await exec(environment, ["sh", "-c", "for i in $(seq 1 100); do test $(wc -l < /home/dim/lifecycle-session) -ge 2 && test $(wc -l < /home/dim/lifecycle-service) -ge 2 && exit 0; sleep .1; done; exit 1"]);
  assert.match(await exec(environment, ["dim-workspace", "service", "list"]), /"running":true/);
}

export async function runWebWorkspaceLifecycle(image: string, chromiumPath: string): Promise<void> {
  const before = await managedResourceSnapshot();
  const environment = await createLifecycleEnvironment(chromiumPath);
  let id: string | undefined;
  let executionError: unknown;
  try {
    assert.deepEqual(parseWorkspaceList((await environment.cli(["ls", "--json"])).stdout), []);
    await environment.page.goto(environment.origin);
    const ui = new WorkspaceUi(environment.page);
    await ui.signIn(environment.username, environment.password);
    await ui.rejectInvalidSource("https://user:secret@example.invalid/repo.git", "bad-input");
    assert.deepEqual(parseWorkspaceList((await environment.cli(["ls", "--json"])).stdout), []);
    await environment.page.getByRole("button", { name: "Cancel new workspace on fixture", exact: true }).click();
    await ui.createWorkspace({ source: environment.repositoryUrl, name: environment.name, image });
    const created = await workspace(environment);
    id = created.id;
    assert.deepEqual(created.resources, { cpuCount: "1", memory: "2g", pidsLimit: "512" });
    await assertOwnedResources(id);
    const names = ownedRuntimeNames(id);
    const initialContainer = await inspectContainer(names.container);
    assertLimits(initialContainer, { cpu: "1000000000", memory: "2147483648", swap: "2147483648", pids: "512" });
    await assertKernelLimits(environment, { cpu: "1", memory: "2g", pids: "512" });
    const stale = await environment.cli(["stop", environment.name, "--expect-id", randomUUID(), "--json"], true);
    assert.notEqual(stale.exitCode, 0);
    assert.equal((await inspectContainer(names.container)).running, true);
    const unconfirmed = await environment.cli(["discard", environment.name, "--expect-id", id, "--json"], true);
    assert.notEqual(unconfirmed.exitCode, 0);
    assert.equal(await resourceExists("container", names.container), true);
    await ui.cancelDiscard(environment.name);
    assert.equal(await resourceExists("container", names.container), true);
    await preserveMarkers(environment);
    await ui.action(environment.name, "stop");
    assert.equal((await inspectContainer(names.container)).running, false);
    await ui.action(environment.name, "start");
    await ui.action(environment.name, "restart");
    const beforeRecreate = (await inspectContainer(names.container)).id;
    await ui.action(environment.name, "recreate");
    const afterRecreate = await inspectContainer(names.container);
    assert.notEqual(afterRecreate.id, beforeRecreate);
    assert.equal((await workspace(environment)).id, id);
    await assertKernelLimits(environment, { cpu: "1", memory: "2g", pids: "512" });
    await assertMarkers(environment);
    for (const values of [
      { cpu: "unlimited", memory: "2g", pids: "512", inspect: { cpu: "0", memory: "2147483648", swap: "2147483648", pids: "512" } },
      { cpu: "1", memory: "unlimited", pids: "512", inspect: { cpu: "1000000000", memory: "0", swap: "-1", pids: "512" } },
      { cpu: "1", memory: "2g", pids: "unlimited", inspect: { cpu: "1000000000", memory: "2147483648", swap: "2147483648", pids: "0" } },
      { cpu: "1", memory: "2g", pids: "512", inspect: { cpu: "1000000000", memory: "2147483648", swap: "2147483648", pids: "512" } }
    ]) {
      await ui.resources(environment.name, values);
      assertLimits(await inspectContainer(names.container), values.inspect);
      await assertKernelLimits(environment, values);
      assert.equal((await workspace(environment)).id, id);
    }
    await assertMarkers(environment);
    await ui.discard(environment.name);
    const owned = ownedResourceKeys(names);
    for (const key of owned) {
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator);
      const name = key.slice(separator + 1);
      if (kind !== "container" && kind !== "network" && kind !== "volume") throw new TypeError("unexpected resource kind");
      assert.equal(await resourceExists(kind, name), false);
    }
    const unrelated = compareUnrelatedResources(before, await managedResourceSnapshot(), owned);
    assert.deepEqual(unrelated, []);
    console.log("web-workspace-lifecycle: real Web, built CLI/host, controller and Sysbox runtime lifecycle PASS");
  } catch (error) {
    executionError = error;
  }
  let cleanupError: unknown;
  try {
    await cleanupOwnedWorkspace(environment, id);
  } catch (error) {
    cleanupError = error;
  }
  try {
    await environment.close({ removeRoot: cleanupError === undefined });
  } catch (error) {
    cleanupError = cleanupError === undefined ? error : new AggregateError([cleanupError, error]);
  }
  if (cleanupError !== undefined) {
    throw new AggregateError([executionError, cleanupError].filter((error) => error !== undefined), "private lifecycle cleanup failed; evidence retained");
  }
  if (executionError !== undefined) throw executionError;
}
