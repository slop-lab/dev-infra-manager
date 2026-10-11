import { afterEach, describe, expect, it } from "vitest";
import { QEMU_CI_SUPERVISOR_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";
import { createSupervisorHarness, type SupervisorHarness } from "./qemuCiRunnerSupervisorHarness.js";

const harnesses: SupervisorHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("QEMU CI supervisor credential boundary", () => {
  it("registers ephemerally in the trusted supervisor and copies only the one-job runner file", async () => {
    // Given: a fake-command supervisor environment with a reusable registration token.
    const harness = await createSupervisorHarness();
    harnesses.push(harness);

    // When: one disposable run completes.
    const result = await harness.run();

    // Then: registration stays local, only .runner crosses SCP, and no reusable token reaches guest transports.
    expect(result.code, result.stderr).toBe(0);
    expect(result.log.filter((line) => line.startsWith("runner "))).toEqual([
      expect.stringMatching(/register --config .*\/register[.]yml --no-interactive --ephemeral/)
    ]);
    expect(result.log.filter((line) => line.startsWith("scp "))).toEqual([
      expect.stringMatching(/scp .* -P [0-9]+ .*\/\.runner dim@127[.]0[.]0[.]1:\/tmp\/\.runner$/)
    ]);
    const guestTransport = result.log.filter((line) => line.startsWith("ssh ") || line.startsWith("scp ")).join("\n");
    expect(guestTransport).not.toContain(harness.registrationToken);
    expect(guestTransport).not.toContain("GITEA_RUNNER_REGISTRATION_TOKEN");
    expect(guestTransport).toContain("daemon --config /etc/dim-act-runner.yml --once");
    expect(guestTransport).toContain("StrictHostKeyChecking=yes");
    expect(result.remainingRunDirectories).toEqual([]);
  });

  it.each([
    ["unsafe mode", { FAKE_RUNNER_MODE: "0644" }],
    ["non-ephemeral shape", { FAKE_RUNNER_JSON: '{"id":1,"uuid":"uuid","name":"runner","token":"token","address":"https://gitea.example.test","labels":["dim-qemu"],"ephemeral":false}' }]
  ])("rejects a generated runner file with %s before SCP", async (_case, extra) => {
    // Given: trusted registration emits an invalid local runner file.
    const harness = await createSupervisorHarness();
    harnesses.push(harness);

    // When: the supervisor validates the registration output.
    const result = await harness.run(extra);

    // Then: the invalid credential never crosses into the guest and all run files are removed.
    expect(result.code).not.toBe(0);
    expect(result.log.some((line) => line.startsWith("scp "))).toBe(false);
    expect(result.remainingRunDirectories).toEqual([]);
  });

  it("uses independent run directories for sequential jobs and removes every run artifact", async () => {
    // Given: one long-lived supervisor environment.
    const harness = await createSupervisorHarness();
    harnesses.push(harness);

    // When: two jobs run sequentially.
    const first = await harness.run();
    const second = await harness.run();

    // Then: each job generated a distinct run-local key path and both directories were removed.
    const keyPaths = [...first.log, ...second.log].filter((line) => line.startsWith("ssh-keygen "));
    expect(new Set(keyPaths).size).toBe(2);
    expect(first.remainingRunDirectories).toEqual([]);
    expect(second.remainingRunDirectories).toEqual([]);
  });

  it("isolates ports and run roots for concurrent supervisor workers", async () => {
    // Given: two workers sharing one trusted supervisor container and data root.
    const harness = await createSupervisorHarness();
    harnesses.push(harness);

    // When: both workers execute concurrently.
    const results = await Promise.all([harness.run(), harness.run()]);

    // Then: relay and SSH ports plus run roots are distinct, token-free, and fully cleaned.
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const log = results.flatMap((result) => result.log);
    const relayPorts = new Set(log.filter((line) => line.startsWith("socat token=")).map((line) => line.match(/TCP-LISTEN:([0-9]+)/)?.[1]));
    const sshPorts = new Set(log.filter((line) => line.startsWith("qemu-start token=")).map((line) => line.match(/ssh_port=([0-9]+)/)?.[1]));
    const curlPorts = new Set(log.filter((line) => line.startsWith("curl ")).map((line) => line.match(/127[.]0[.]0[.]1:([0-9]+)/)?.[1]));
    const cloudPorts = new Set(log.filter((line) => line.startsWith("cloud-localds ")).map((line) => line.match(/10[.]0[.]2[.]2:([0-9]+)/)?.[1]));
    const daemonPorts = new Set(log.filter((line) => line.startsWith("ssh ") && line.includes(" daemon ")).map((line) => line.match(/DIM_CI_REGISTRY_CACHE_UPSTREAM=10[.]0[.]2[.]2:([0-9]+)/)?.[1]));
    const scanPorts = new Set(log.filter((line) => line.startsWith("ssh-keyscan ")).map((line) => line.match(/port=([0-9]+)/)?.[1]));
    const transportPorts = new Set(log.filter((line) => line.startsWith("ssh ") || line.startsWith("scp ")).map((line) => line.match(/ -[pP] ([0-9]+)/)?.[1]));
    const runRoots = new Set(log.filter((line) => line.startsWith("ssh-keygen ")).map((line) => line.replace(/\/id$/, "")));
    expect(relayPorts.size).toBe(2);
    expect(sshPorts.size).toBe(2);
    expect(curlPorts).toEqual(relayPorts);
    expect(cloudPorts).toEqual(relayPorts);
    expect(daemonPorts).toEqual(relayPorts);
    expect(scanPorts).toEqual(sshPorts);
    expect(transportPorts).toEqual(sshPorts);
    expect(runRoots.size).toBe(2);
    expect(log.filter((line) => line.startsWith("socat ") || line.startsWith("qemu-start ")).every((line) => line.includes("token= "))).toBe(true);
    expect(await harness.remainingRunDirectories()).toEqual([]);
  });

  it("times out a stuck one-job daemon, terminates QEMU, and removes the run directory", async () => {
    // Given: a guest daemon that never completes and a one-second supervisor bound.
    const harness = await createSupervisorHarness();
    harnesses.push(harness);

    // When: the supervisor runs the stuck daemon.
    const result = await harness.run({ FAKE_DAEMON_HANG: "1", FAKE_QEMU_IGNORE_TERM: "1" });

    // Then: timeout fails promptly while cleanup terminates QEMU and deletes all ephemeral files.
    expect(result.code).not.toBe(0);
    expect(result.durationMs).toBeLessThan(3_750);
    expect(result.log).toContain("qemu-term-ignored");
    expect(result.remainingRunDirectories).toEqual([]);
  });

  it("keeps the reusable token out of generated cloud-init", async () => {
    // Given: the generated supervisor shell's cloud-init heredoc.
    const userData = QEMU_CI_SUPERVISOR_SCRIPT.match(/cat >"\$cleanup_dir\/user-data" <<EOF\n([\s\S]*?)\nEOF/)?.[1];

    // When: the cloud-init payload is inspected as the guest-disk input.
    expect(userData).toBeDefined();

    // Then: no registration credential source is serialized into the seed image.
    expect(userData).not.toContain("GITEA_RUNNER_REGISTRATION_TOKEN");
    expect(userData).not.toContain(".runner");
  });
});
