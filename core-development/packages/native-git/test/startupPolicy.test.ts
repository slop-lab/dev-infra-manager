import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeGitServer,
  initializeNativeRepository,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DIM native Git startup policy", () => {
  it("refuses to listen when a registered repository receive hook was replaced", async () => {
    // Given
    const root = await temporaryRoot();
    const config = serviceConfig(root, "2.43.0");
    const repositoryPath = await initializeNativeRepository(config, firstRepository(config));
    await writeFile(join(repositoryPath, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const service = createNativeGitServer(config);

    // When / Then
    await expect(service.listen()).rejects.toThrow(/policy hook/);
    expect(service.server.listening).toBe(false);
  });

  it("refuses repository initialization when the Git version pin differs", async () => {
    // Given
    const root = await temporaryRoot();
    const config = serviceConfig(root, "9.9.9");

    // When / Then
    await expect(initializeNativeRepository(config, firstRepository(config))).rejects.toThrow(/expected Git 9.9.9/);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-git-policy-"));
  roots.push(root);
  return root;
}

function serviceConfig(root: string, gitVersion: string): NativeGitServiceConfig {
  return {
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 0,
    storageRoot: join(root, "storage"),
    gitExecutable: "/usr/bin/git",
    gitVersion,
    repositories: [{ projectId: "project-a", repositoryId: "source" }],
    identities: [{
      role: "reader",
      username: "reader-a",
      password: "reader-a-secret-1",
      projectId: "project-a",
      repositoryIds: ["source"]
    }]
  };
}

function firstRepository(config: NativeGitServiceConfig): NativeGitServiceConfig["repositories"][number] {
  const repository = config.repositories[0];
  if (repository === undefined) throw new Error("test fixture requires a repository");
  return repository;
}
