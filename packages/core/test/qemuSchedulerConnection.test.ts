import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { qemuSchedulerConnection } from "../../../../core/packages/core/src/qemuSchedulerConnection.js";

const roots: string[] = [];
const project = { name: "example", id: "shared-project" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU scheduler connection", () => {
  it("binds distinct controller, supervisor, and webhook endpoints to Project and host identity", async () => {
    // Given
    const file = await connectionFile();
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/dim", DIM_GITEA_CONNECTION_FILE: "/private/gitea.json", DIM_QEMU_SCHEDULER_CONNECTION_FILE: file
    });

    // When
    const connection = await qemuSchedulerConnection(options, project);

    // Then
    expect(connection).toEqual({
      projectId: "shared-project", hostId: "host-a",
      controllerEndpoint: "http://127.0.0.1:9080",
      supervisorEndpoint: "http://127.0.0.1:19080",
      webhookUrl: "http://127.0.0.1:29080/v1/webhooks/shared-project/workflow-job",
      hostToken: "host-token", webhookToken: "webhook-token"
    });
  });

  it("rejects unknown fields, mixed managed Gitea mode, and non-loopback HTTP by default", async () => {
    // Given
    const unknown = await connectionFile({ unexpected: true });
    const remoteHttp = await connectionFile({ controllerEndpoint: "http://scheduler.example:9080" });
    const external = (file: string) => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/dim", DIM_GITEA_CONNECTION_FILE: "/private/gitea.json", DIM_QEMU_SCHEDULER_CONNECTION_FILE: file
    });
    const managed = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/dim", DIM_QEMU_SCHEDULER_CONNECTION_FILE: await connectionFile()
    });

    // When / Then
    await expect(qemuSchedulerConnection(external(unknown), project)).rejects.toThrow(/unknown field/);
    await expect(qemuSchedulerConnection(external(remoteHttp), project)).rejects.toThrow(/loopback-http/);
    await expect(qemuSchedulerConnection(managed, project)).rejects.toThrow(/external Gitea/);
  });

  it("requires a private host-owned file and exact shared Project identity", async () => {
    // Given
    const file = await connectionFile({ projectId: "other" });
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/dim", DIM_GITEA_CONNECTION_FILE: "/private/gitea.json", DIM_QEMU_SCHEDULER_CONNECTION_FILE: file
    });

    // When / Then
    await expect(qemuSchedulerConnection(options, project)).rejects.toThrow(/identity.*local Project state/);
    await chmod(file, 0o644);
    await expect(qemuSchedulerConnection(options, project)).rejects.toThrow(/mode 0600/);
  });
});

async function connectionFile(overrides: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-scheduler-connection-"));
  roots.push(root);
  const file = join(root, "connection.json");
  const projectFields = {
    projectId: overrides.projectId ?? "shared-project",
    controllerEndpoint: overrides.controllerEndpoint ?? "http://127.0.0.1:9080",
    supervisorEndpoint: "http://127.0.0.1:19080",
    webhookUrl: "http://127.0.0.1:29080/v1/webhooks/shared-project/workflow-job",
    hostToken: "host-token",
    webhookToken: "webhook-token"
  };
  const rootFields = {
    schemaVersion: 1,
    transport: "loopback-http",
    hostId: "host-a",
    projects: { example: projectFields },
    ...(overrides.unexpected === true ? { unexpected: true } : {})
  };
  await writeFile(file, JSON.stringify(rootFields), { mode: 0o600 });
  return file;
}
