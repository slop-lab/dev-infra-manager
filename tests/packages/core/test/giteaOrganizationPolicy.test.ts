import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { ensureGitea } from "../../../../core/packages/core/src/gitea.js";
import { giteaOrganizationPolicyCheckArgs } from "../../../../core/packages/core/src/giteaContainer.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CommandResult, CommandRunner, RunOptions } from "../../../../core/packages/core/src/types.js";
import {
  GITEA_CREDENTIALS,
  GiteaPolicyRunner,
  giteaContainer
} from "./giteaOrganizationPolicyFixture.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";
import {
  claimTestGiteaService,
  ownedGiteaContainerInspect,
  ownedGiteaResourceInspect
} from "./giteaServiceFixture.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "127.0.0.1", family: 4 }))
}));

const execFileAsync = promisify(execFile);
const CREDENTIAL_PATH = "/data/dim/credentials.json";

class GiteaCreationRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private created = false;
  private running = false;

  async run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      return { command, args, stdout: `${ownedGiteaResourceInspect(args[0])}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return this.created
        ? { command, args, stdout: `${ownedGiteaContainerInspect("created-gitea-id", this.running)}\n`, stderr: "", exitCode: 0 }
        : { command, args, stdout: "", stderr: `Error: No such container: ${args[2] ?? "dim-gitea"}`, exitCode: 1 };
    }
    if (args.some((argument) => argument.includes(CREDENTIAL_PATH))) {
      return { command, args, stdout: JSON.stringify(GITEA_CREDENTIALS), stderr: "", exitCode: 0 };
    }
    if (args.some((argument) => argument.includes("awk"))) {
      return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "create") {
      this.created = true;
      return { command, args, stdout: "created-gitea-id\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "start") this.running = true;
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("managed Gitea organization policy", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it.each([
    {
      name: "one true entry",
      appIni: "[service]\nDISABLE_REGISTRATION=true\n[admin]\nDISABLE_REGULAR_ORG_CREATION = true\n",
      expected: "true"
    },
    {
      name: "duplicate true entries",
      appIni: "[admin]\nDISABLE_REGULAR_ORG_CREATION=true\nDISABLE_REGULAR_ORG_CREATION=true\n",
      expected: "false"
    },
    {
      name: "true then false entries",
      appIni: "[admin]\nDISABLE_REGULAR_ORG_CREATION=true\nDISABLE_REGULAR_ORG_CREATION=false\n",
      expected: "false"
    },
    {
      name: "false then true entries",
      appIni: "[admin]\nDISABLE_REGULAR_ORG_CREATION=false\nDISABLE_REGULAR_ORG_CREATION=true\n",
      expected: "false"
    },
    { name: "missing entry", appIni: "[admin]\n", expected: "false" }
  ])("reports canonical policy for $name", async ({ appIni, expected }) => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "dim-gitea-policy-script-"));
    cleanup.push(directory);
    const configPath = join(directory, "app.ini");
    await writeFile(configPath, appIni);
    const script = giteaOrganizationPolicyCheckArgs("container-id").at(-1);
    if (script === undefined) throw new Error("missing organization policy check script");

    // When
    const checked = await execFileAsync("sh", ["-c", script.replace("/data/gitea/conf/app.ini", configPath)]);

    // Then
    expect(checked.stdout.trim()).toBe(expected);
  });

  it("disables ordinary organization creation through Gitea's admin setting", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new GiteaCreationRunner();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    await ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    const creation = runner.calls.find((call) => call[1] === "container" && call[2] === "create");
    expect(creation?.filter((argument) =>
      argument === "GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true")).toHaveLength(1);
    expect(creation).not.toContain("GITEA__service__DEFAULT_ALLOW_CREATE_ORGANIZATION=false");
  });

  it("reconciles a running owned container by inspected ID before readiness and credentials", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new GiteaPolicyRunner(giteaContainer({
      id: "owned-gitea-id", running: true, policyEntries: [false]
    }));
    runner.replaceNameAfterInspect(giteaContainer({
      id: "foreign-replacement-id", running: true, policyEntries: [false], managed: false
    }));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    await ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    expect(runner.calls).toContainEqual(expect.arrayContaining(["docker", "exec", "--user", "git", "owned-gitea-id"]));
    expect(runner.calls).toContainEqual(expect.arrayContaining(["docker", "restart", "owned-gitea-id"]));
    expect(runner.calls.filter((call) => call[1] === "exec" || call[1] === "restart")
      .some((call) => call.includes("dim-gitea"))).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("starts and reconciles a stopped owned container by inspected ID before readiness", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new GiteaPolicyRunner(giteaContainer({
      id: "stopped-gitea-id", running: false, policyEntries: [false]
    }));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    await ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    expect(runner.calls).toContainEqual(["docker", "start", "stopped-gitea-id"]);
    expect(runner.calls).toContainEqual(expect.arrayContaining(["docker", "restart", "stopped-gitea-id"]));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a foreign container before exec, start, restart, or readiness", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new GiteaPolicyRunner(giteaContainer({
      id: "foreign-gitea-id", running: false, policyEntries: [false], managed: false
    }));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const reconciliation = ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    await expect(reconciliation).rejects.toThrow(/not managed by dim/);
    expect(runner.calls.some((call) => ["exec", "start", "restart"].includes(call[1] ?? ""))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "start" as const, running: false, message: "start failed" },
    { failure: "policy-check" as const, running: true, message: "policy check failed" },
    { failure: "policy-output" as const, running: true, message: "unexpected output" },
    { failure: "policy-edit" as const, running: true, message: "policy edit failed" },
    { failure: "restart" as const, running: true, message: "restart failed" }
  ])("propagates $failure failure before credentials or readiness", async ({ failure, running, message }) => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new GiteaPolicyRunner(giteaContainer({
      id: "owned-gitea-id", running, policyEntries: [false]
    }), failure);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const reconciliation = ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    await expect(reconciliation).rejects.toThrow(message);
    expect(runner.calls.some((call) => call.some((argument) => argument.includes(CREDENTIAL_PATH)))).toBe(false);
    if (failure === "policy-check" || failure === "policy-output") {
      expect(runner.calls.some((call) => call.includes("edit-ini") || call[1] === "restart")).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects policy reversion after restart before readiness or credentials", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new GiteaPolicyRunner(giteaContainer({
      id: "owned-gitea-id", running: true, policyEntries: [false]
    }), "policy-revert");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const reconciliation = ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    await expect(reconciliation).rejects.toThrow(/organization policy/);
    const policyChecks = runner.calls.filter((call) => call.some((argument) => argument.includes("awk")));
    expect(policyChecks).toHaveLength(2);
    expect(policyChecks.every((call) => call.includes("owned-gitea-id"))).toBe(true);
    expect(runner.calls).toContainEqual(["docker", "restart", "owned-gitea-id"]);
    expect(runner.calls.some((call) => call.some((argument) => argument.includes(CREDENTIAL_PATH)))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reconcile runtime resources for a non-missing record error containing not found", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-policy-"));
    cleanup.push(stateRoot);
    const readFailure = new UserError("Gitea record could not be parsed: not found in expected shape");
    const claim = vi.spyOn(LifecycleState.prototype, "claimGiteaService").mockResolvedValue();
    vi.spyOn(LifecycleState.prototype, "readGiteaService").mockRejectedValue(readFailure);
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        throw new Error("runtime reconciliation dispatched");
      }
    };

    // When
    const reconciliation = ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    await expect(reconciliation).rejects.toBe(readFailure);
    expect(claim).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
