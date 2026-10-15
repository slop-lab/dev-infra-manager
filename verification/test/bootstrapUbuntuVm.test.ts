import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleVersion, cleanup, executeArgs, fixture, run } from "./fixtures/bootstrapUbuntuVm.js";

afterEach(async () => {
  await cleanup();
});

describe("Ubuntu VM role bootstrap", () => {
  it("keeps help and plan read-only even for a dirty preview", async () => {
    // Given
    const value = await fixture();

    // When
    const help = run(value, ["--help"]);
    const plan = run(value, ["--role", "ordinary", "--print-plan"], { DIM_TEST_STATUS: " M preview\n" });

    // Then
    expect(help).toMatchObject({ status: 0 });
    expect(help.stdout).toContain("--acknowledge-fresh-vm");
    expect(plan).toMatchObject({ status: 0 });
    expect(plan.stdout).toContain("candidate-validation: not-performed");
    expect(await readFile(value.log, "utf8")).toBe("");
  });

  it("rejects a dirty source before invoking privileged helpers", async () => {
    // Given
    const value = await fixture();

    // When
    const result = run(value, executeArgs, { DIM_TEST_STATUS: " M package.json\n" });

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("clean checkout");
    expect(await readFile(value.log, "utf8")).toBe("");
  });

  it("stops for a new login after adding the Docker group", async () => {
    // Given
    const value = await fixture("operator");

    // When
    const result = run(value, executeArgs);

    // Then
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("log out and back in");
    expect(await readFile(value.log, "utf8")).toContain("host.bash sysbox docker-ce");
    expect(await readFile(value.log, "utf8")).not.toContain("just prepare-local");
    expect(await readFile(resolve(value.home, ".local/state/dim-bootstrap/ubuntu-vm.state"), "utf8")).toContain("phase=awaiting-login");
  });

  it("resumes only the exact marked role without rerunning host installers", async () => {
    // Given
    const value = await fixture("operator");
    expect(run(value, executeArgs).status).toBe(3);

    // When
    const result = run(value, executeArgs, { DIM_TEST_GROUPS: "operator docker" });

    // Then
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect((await readFile(value.log, "utf8")).match(/^host\.bash/gm)).toHaveLength(1);
  });

  it("installs ordinary role source and promotes its exact installer facade", async () => {
    // Given
    const value = await fixture();

    // When
    const result = run(value, executeArgs);

    // Then
    expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({ status: 0 });
    const commands = await readFile(value.log, "utf8");
    expect(commands).toContain("host.bash sysbox docker-ce");
    expect(commands).not.toContain("kvm.bash");
    expect(commands).toContain("just prepare-local");
    expect(commands).toContain("just install-local");
    expect(await readFile(resolve(value.home, ".local/bin/dim"), "utf8")).toContain("dim-candidates");
    const facade = spawnSync(resolve(value.home, ".local/bin/dim"), ["--version"], {
      encoding: "utf8",
      env: { HOME: value.home, PATH: "/usr/bin:/bin" },
    });
    expect(facade).toMatchObject({ status: 0, stdout: `DIM CLI ${bundleVersion} (via DIM installer ${bundleVersion})\n` });
    expect(await readFile(value.trustedNodeLog, "utf8")).toContain("trusted-node");
  });

  it("requires real KVM and dispatches control-qemu dependencies", async () => {
    // Given
    const value = await fixture();
    const args = executeArgs.map((argument) => argument === "ordinary" ? "control-qemu" : argument);

    // When
    const result = run(value, args);

    // Then
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(await readFile(value.log, "utf8")).toContain("kvm.bash operator");
    expect(result.stdout).toContain("functional acceleration not probed");
  });

  it("rejects control-qemu before mutation when real KVM is absent", async () => {
    // Given
    const value = await fixture();
    const source = await readFile(value.bootstrap, "utf8");
    await writeFile(value.bootstrap, source.replace("kvm_device=/dev/null", `kvm_device=${JSON.stringify(resolve(value.home, "missing-kvm"))}`));
    const args = executeArgs.map((argument) => argument === "ordinary" ? "control-qemu" : argument);

    // When
    const result = run(value, args);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TCG fallback is forbidden");
    expect(await readFile(value.log, "utf8")).toBe("");
  });

  it("rejects a Docker Compose plugin outside the exact pin", async () => {
    // Given
    const value = await fixture();

    // When
    const result = run(value, executeArgs, { DIM_TEST_COMPOSE_VERSION: "5.0.2" });

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker Compose is not pinned 2.40.3");
  });

  it.each([
    ["Docker context", { DIM_TEST_DOCKER_CONTEXT: "remote" }, "Docker context must be default"],
    ["Docker endpoint", { DIM_TEST_DOCKER_ENDPOINT: "tcp://remote.example:2376" }, "Docker endpoint must be the local system socket"],
    ["Docker package", { DIM_TEST_DOCKER_PACKAGE_VERSION: "5:29.1.3-1~ubuntu.24.04~noble" }, "pinned host package mismatch"],
  ])("rejects %s drift after host installation", async (_label, environment, message) => {
    const value = await fixture();

    const result = run(value, executeArgs, environment);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await readFile(value.log, "utf8")).not.toContain("just prepare-local");
  });

  it("rejects prepared-state drift during facade staging", async () => {
    const value = await fixture();

    const result = run(value, executeArgs, { DIM_TEST_MUTATE_PREPARED: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("prepared bundle changed while staging candidate facade");
    await expect(readFile(resolve(value.home, ".local/bin/dim"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a foreign facade instead of replacing it", async () => {
    // Given
    const value = await fixture();
    await mkdir(resolve(value.home, ".local/bin"), { recursive: true });
    await writeFile(resolve(value.home, ".local/bin/dim"), "foreign\n");

    // When
    const result = run(value, executeArgs);

    // Then
    expect(result.status).not.toBe(0);
    expect(await readFile(resolve(value.home, ".local/bin/dim"), "utf8")).toBe("foreign\n");
  });

  it.each([
    ["DIM state", ".local/state/dim", {}],
    ["redirected DIM config", "", { DIM_CONFIG_PATH: "/foreign/dim.json" }],
    ["redirected Docker endpoint", "", { DOCKER_HOST: "tcp://remote.example:2376" }],
    ["Docker volume", "", { DIM_TEST_VOLUMES: "foreign-volume" }],
    ["Docker daemon configuration", "daemon.json", {}],
    ["Docker data root", "var/lib/docker", {}],
    ["containerd data root", "var/lib/containerd", {}],
  ])("refuses pre-existing %s before privileged mutation", async (_label, path, environment) => {
    // Given
    const value = await fixture();
    if (path !== "") {
      const target = path === "daemon.json" || path.startsWith("var/") ? resolve(value.root, path) : resolve(value.home, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, "foreign\n").catch(async () => mkdir(target, { recursive: true }));
    }

    // When
    const result = run(value, executeArgs, environment);

    // Then
    expect(result.status).toBe(2);
    expect(await readFile(value.log, "utf8")).toBe("");
  });
});
