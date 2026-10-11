import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, chmod, copyFile, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeGitServer,
  initializeNativeRepository,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";

const roots: string[] = [];
const run = promisify(execFile);

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

  it("refuses to listen when repository config redirects the policy hook", async () => {
    // Given
    const root = await temporaryRoot();
    const config = serviceConfig(root, "2.43.0");
    const repositoryPath = await initializeNativeRepository(config, firstRepository(config));
    await run(config.gitExecutable, ["--git-dir", repositoryPath, "config", "core.hooksPath", join(root, "bypass-hooks")]);
    const service = createNativeGitServer(config);

    // When / Then
    await expect(service.listen()).rejects.toThrow(/hooks path/);
    expect(service.server.listening).toBe(false);
  });

  it("refuses a registered repository reached through a lexical symlink", async () => {
    // Given
    const root = await temporaryRoot();
    const config = serviceConfig(root, "2.43.0");
    const registeredPath = await initializeNativeRepository(config, firstRepository(config));
    const foreign = { projectId: "project-b", repositoryId: "source" } as const;
    const foreignPath = await initializeNativeRepository(config, foreign);
    await rm(registeredPath, { recursive: true });
    await symlink(foreignPath, registeredPath);
    const service = createNativeGitServer(config);

    // When / Then
    await expect(service.listen()).rejects.toThrow(/symbolic link/);
    expect(service.server.listening).toBe(false);
  });

  it("preserves a foreign hook target when pre-receive is a symbolic link", async () => {
    // Given
    const root = await temporaryRoot();
    const config = serviceConfig(root, "2.43.0");
    const repository = firstRepository(config);
    const repositoryPath = await initializeNativeRepository(config, repository);
    const hookPath = join(repositoryPath, "hooks", "pre-receive");
    const foreignPath = join(root, "foreign-hook");
    const foreignBytes = "foreign-owned\n";
    await writeFile(foreignPath, foreignBytes);
    await rm(hookPath);
    await symlink(foreignPath, hookPath);

    // When / Then
    await expect(initializeNativeRepository(config, repository)).rejects.toThrow(/policy hook/);
    await expect(readFile(foreignPath, "utf8")).resolves.toBe(foreignBytes);
  });

  it("does not execute a Git path replaced after startup validation", async () => {
    // Given
    const root = await temporaryRoot();
    const executable = join(root, "git");
    const replacement = join(root, "replacement");
    const marker = join(root, "replacement-ran");
    await copyFile("/usr/bin/git", executable);
    await chmod(executable, 0o700);
    const config = serviceConfig(root, "2.43.0", executable);
    await initializeNativeRepository(config, firstRepository(config));
    const service = createNativeGitServer(config);
    const baseUrl = await service.listen();
    await writeFile(replacement, `#!/bin/sh\nprintf '%s\\n' 'git version 2.43.0'\n: > '${marker}'\nprintf 'Content-Type: text/plain\\r\\n\\r\\n'\n`, { mode: 0o700 });
    await rename(replacement, executable);

    try {
      // When
      const response = await fetch(`${baseUrl}/v1/projects/project-a/repositories/source.git/info/refs?service=git-upload-pack`, {
        headers: { Authorization: `Basic ${Buffer.from("reader-a:reader-a-secret-1").toString("base64")}` }
      });

      // Then
      expect(response.status).toBe(503);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await service.close();
    }
  });

  it("withholds identity while the service is not ready", async () => {
    // Given
    const root = await temporaryRoot();
    const config = serviceConfig(root, "2.43.0");
    const service = createNativeGitServer(config);
    service.server.listen(0, config.host);
    await once(service.server, "listening");
    const address = service.server.address();
    if (address === null || typeof address === "string") throw new Error("test requires a TCP listener");

    try {
      // When
      const response = await fetch(`http://${config.host}:${address.port}/v1/identity`, {
        headers: { Authorization: `Basic ${Buffer.from("reader-a:reader-a-secret-1").toString("base64")}` }
      });

      // Then
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    } finally {
      await service.close();
    }
  });

  it("withholds identity when the validated Git executable changes", async () => {
    // Given
    const root = await temporaryRoot();
    const executable = join(root, "git");
    const replacement = join(root, "replacement");
    const marker = join(root, "identity-replacement-ran");
    await copyFile("/usr/bin/git", executable);
    await chmod(executable, 0o700);
    const config = serviceConfig(root, "2.43.0", executable);
    await initializeNativeRepository(config, firstRepository(config));
    const service = createNativeGitServer(config);
    const baseUrl = await service.listen();
    await writeFile(replacement, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });
    await rename(replacement, executable);

    try {
      // When
      const response = await fetch(`${baseUrl}/v1/identity`, {
        headers: { Authorization: `Basic ${Buffer.from("reader-a:reader-a-secret-1").toString("base64")}` }
      });

      // Then
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await service.close();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-git-policy-"));
  roots.push(root);
  return root;
}

function serviceConfig(root: string, gitVersion: string, gitExecutable = "/usr/bin/git"): NativeGitServiceConfig {
  return {
    schemaVersion: 2,
    serviceId: "native-main",
    host: "127.0.0.1",
    port: 0,
    storageRoot: join(root, "storage"),
    gitExecutable,
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
