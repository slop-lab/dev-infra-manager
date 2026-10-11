import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureGitea } from "../../../../core/packages/core/src/gitea.js";
import type { CommandResult, CommandRunner } from "../../../../core/packages/core/src/types.js";
import { GITEA_CREDENTIALS } from "./giteaOrganizationPolicyFixture.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";
import {
  claimTestGiteaService,
  ownedGiteaContainerInspect,
  ownedGiteaResourceInspect
} from "./giteaServiceFixture.js";

const CREDENTIAL_PATH = "/data/dim/credentials.json";
const MISSING_CREDENTIAL_EXIT_CODE = 42;

type CredentialRead = {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

class CredentialRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly mutations: string[] = [];

  constructor(private readonly credentialRead: CredentialRead) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      return result(command, args, { exitCode: 0, stdout: `${ownedGiteaResourceInspect(args[0])}\n` });
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return result(command, args, { exitCode: 0, stdout: `${ownedGiteaContainerInspect("credential-container-id", true)}\n` });
    }
    if (args.some((argument) => argument.startsWith("DIM_CREDENTIALS="))) {
      this.mutations.push("store");
      return result(command, args, { exitCode: 0 });
    }
    if (args.some((argument) => argument.includes(CREDENTIAL_PATH))) {
      return result(command, args, this.credentialRead);
    }
    if (args.some((argument) => argument.includes("awk"))) {
      return result(command, args, { exitCode: 0, stdout: "true\n" });
    }
    if (args.includes("user") && args.includes("create")) {
      this.mutations.push("create-user");
      return result(command, args, { exitCode: 0 });
    }
    return result(command, args, { exitCode: 0 });
  }
}

function result(command: string, args: string[], output: CredentialRead): CommandResult {
  return {
    command,
    args,
    exitCode: output.exitCode,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? ""
  };
}

function isCredentialRead(call: readonly string[]): boolean {
  return call.some((argument) => argument.includes(CREDENTIAL_PATH))
    && !call.some((argument) => argument.startsWith("DIM_CREDENTIALS="));
}

describe("managed Gitea credential reconciliation", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates credentials only for the reserved missing-path result", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-credentials-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new CredentialRunner({ exitCode: MISSING_CREDENTIAL_EXIT_CODE });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    await ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    expect(runner.mutations).toEqual(["create-user", "create-user", "create-user", "store"]);
    const read = runner.calls.find(isCredentialRead);
    expect(read).toEqual(expect.arrayContaining(["docker", "exec", "credential-container-id", "sh", "-c"]));
    expect(read?.at(-1)).toContain(`test ! -e ${CREDENTIAL_PATH}`);
    expect(read?.at(-1)).toContain(`exit ${MISSING_CREDENTIAL_EXIT_CODE}`);
  });

  it.each([
    { exitCode: 1, stderr: "permission denied" },
    { exitCode: 127, stderr: "credential reader unavailable" }
  ])("propagates credential read exit $exitCode without mutation", async (credentialRead) => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-credentials-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new CredentialRunner(credentialRead);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const reconciliation = ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    await expect(reconciliation).rejects.toThrow(credentialRead.stderr);
    expect(runner.mutations).toEqual([]);
  });

  it.each([
    { name: "malformed JSON", stdout: "{", message: /JSON/ },
    {
      name: "incomplete JSON",
      stdout: JSON.stringify({ ...GITEA_CREDENTIALS, writerPassword: "" }),
      message: /incomplete/
    },
    {
      name: "missing maintainer credential",
      stdout: JSON.stringify({
        adminUsername: GITEA_CREDENTIALS.adminUsername,
        adminPassword: GITEA_CREDENTIALS.adminPassword,
        writerUsername: GITEA_CREDENTIALS.writerUsername,
        writerPassword: GITEA_CREDENTIALS.writerPassword,
        maintainerUsername: GITEA_CREDENTIALS.maintainerUsername
      }),
      message: /incomplete/
    }
  ])("propagates $name without mutation", async ({ stdout, message }) => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-credentials-"));
    cleanup.push(stateRoot);
    await claimTestGiteaService(stateRoot);
    const runner = new CredentialRunner({ exitCode: 0, stdout });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const reconciliation = ensureGitea(runner, hostLifecycleOptions(stateRoot));

    // Then
    await expect(reconciliation).rejects.toThrow(message);
    expect(runner.mutations).toEqual([]);
  });
});
