import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { MissingRecordError, UserError } from "./errors.js";
import {
  ensureGiteaOrganizationPolicy,
  GITEA_CONTAINER,
  giteaContainerCreationArgs,
  giteaWebhookConfigArgs,
  GITEA_NETWORK,
  GITEA_VOLUME,
  inspectGiteaContainer
} from "./giteaContainer.js";
import { ensureGiteaCredentials } from "./giteaCredentials.js";
import { ensureGiteaBaseResources, resolveGiteaImageId } from "./giteaResources.js";
import { LifecycleState } from "./lifecycleState.js";
import type { GiteaConnection, GiteaServiceRecord, LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export async function ensureManagedGitea(
  runner: CommandRunner,
  options: LifecycleOptions
): Promise<GiteaConnection> {
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireGiteaServiceLock();
  try {
    return await ensureManagedGiteaLocked(runner, options, state);
  } finally {
    await release();
  }
}

export async function configureManagedGiteaWebhookAllowedHosts(
  runner: CommandRunner,
  options: LifecycleOptions,
  hosts: string[]
): Promise<void> {
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireGiteaServiceLock();
  try {
    await ensureManagedGiteaLocked(runner, options, state);
    try {
      const record = await state.readGiteaService();
      const container = await inspectGiteaContainer(runner, record);
      if (container === undefined) throw new UserError(`Docker resource '${GITEA_CONTAINER}' does not exist`);
      assertCommand(
        await runner.run("docker", giteaWebhookConfigArgs(container.id, hosts)),
        "configure Gitea webhook targets"
      );
      assertCommand(
        await runner.run("docker", ["restart", container.id]),
        "restart Gitea after webhook configuration"
      );
      await ensureGiteaOrganizationPolicy(runner, container.id);
      await readyGiteaConnection(runner, options, container.id, container.endpointAddress);
      const current = await state.readGiteaService();
      const ready = { ...current, phase: "ready", updatedAt: new Date().toISOString() } satisfies GiteaServiceRecord;
      delete ready.error;
      await state.writeGiteaService(ready);
    } catch (error) {
      const record = await state.readGiteaService();
      await state.writeGiteaService({
        ...record,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
      throw error;
    }
  } finally {
    await release();
  }
}

async function ensureManagedGiteaLocked(
  runner: CommandRunner,
  options: LifecycleOptions,
  state: LifecycleState
): Promise<GiteaConnection> {
  const now = new Date().toISOString();
  let record: GiteaServiceRecord;
  try {
    record = await state.readGiteaService();
    if (record.port !== options.giteaPort) {
      throw new UserError(`Gitea is already managed on port ${record.port}; requested ${options.giteaPort}`);
    }
    if (record.image !== options.giteaImage) {
      throw new UserError(`Gitea is already managed with image '${record.image}'; requested '${options.giteaImage}'`);
    }
  } catch (error) {
    if (!(error instanceof MissingRecordError)) throw error;
    const imageId = await resolveGiteaImageId(runner, options.giteaImage);
    record = {
      schemaVersion: 2,
      serviceId: randomBytes(32).toString("base64url"),
      containerOwnershipId: randomBytes(32).toString("base64url"),
      networkOwnershipId: randomBytes(32).toString("base64url"),
      volumeOwnershipId: randomBytes(32).toString("base64url"),
      phase: "creating",
      containerName: GITEA_CONTAINER,
      networkName: GITEA_NETWORK,
      volumeName: GITEA_VOLUME,
      image: options.giteaImage,
      imageId,
      resourcesEstablished: false,
      port: options.giteaPort,
      createdAt: now,
      updatedAt: now
    };
    await state.claimGiteaService(record);
  }

  try {
    const reconciled = await reconcileManagedGiteaResources(runner, options, state, record);
    record = { ...reconciled.record, phase: "ready", updatedAt: new Date().toISOString() };
    delete record.error;
    await state.writeGiteaService(record);
    return reconciled.connection;
  } catch (error) {
    const current = await state.readGiteaService();
    await state.writeGiteaService({
      ...current,
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    });
    throw error;
  }
}

async function reconcileManagedGiteaResources(
  runner: CommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: GiteaServiceRecord
): Promise<{ readonly connection: GiteaConnection; readonly record: GiteaServiceRecord }> {
  let record = initialRecord;
  let container = await inspectGiteaContainer(runner, record);
  const networkId = await ensureGiteaBaseResources(runner, record, !record.resourcesEstablished);
  if (!record.resourcesEstablished) {
    record = {
      ...record,
      networkId,
      resourcesEstablished: true,
      updatedAt: new Date().toISOString()
    };
    await state.writeGiteaService(record);
  }
  if (container === undefined) {
    const publishAddress = (await lookup(options.giteaHost)).address;
    const created = await runner.run(
      "docker",
      giteaContainerCreationArgs(options, publishAddress, giteaHostBaseUrl(options), record, record.endpointAddress)
    );
    assertCommand(created, "create Gitea container");
    const containerId = created.stdout.trim();
    if (containerId.length === 0) throw new UserError("Failed to create Gitea container: Docker returned no container ID");
    container = await inspectGiteaContainer(runner, record, containerId);
    if (container === undefined) throw new UserError("Failed to inspect the created Gitea container by immutable ID");
  }
  if (record.endpointAddress !== undefined && record.endpointAddress !== container.endpointAddress) {
    throw new UserError(
      `Managed Gitea endpoint address changed from ${record.endpointAddress} to ${container.endpointAddress}; `
      + "refusing to invalidate existing workspace aliases"
    );
  }
  if (record.endpointAddress === undefined) {
    record = { ...record, endpointAddress: container.endpointAddress, updatedAt: new Date().toISOString() };
    await state.writeGiteaService(record);
  }
  if (!container.running) {
    assertCommand(await runner.run("docker", ["start", container.id]), "start existing Gitea");
  }
  await ensureGiteaOrganizationPolicy(runner, container.id);
  return {
    connection: await readyGiteaConnection(runner, options, container.id, container.endpointAddress),
    record
  };
}

async function readyGiteaConnection(
  runner: CommandRunner,
  options: LifecycleOptions,
  containerId: string,
  endpointAddress: string
): Promise<GiteaConnection> {
  const baseUrl = giteaHostBaseUrl(options);
  await waitForGitea(baseUrl);
  return {
    kind: "managed",
    endpointAddress,
    ...await ensureGiteaCredentials(runner, options, containerId),
    apiBaseUrl: `${baseUrl}/api/v1`,
    hostBaseUrl: baseUrl,
    workspaceBaseUrl: "http://dim-gitea:3000",
    runnerBaseUrl: "http://dim-gitea:3000"
  };
}

function giteaHostBaseUrl(options: LifecycleOptions): string {
  const host = options.giteaHost.includes(":") ? `[${options.giteaHost}]` : options.giteaHost;
  return `http://${host}:${options.giteaPort}`;
}

async function waitForGitea(baseUrl: string): Promise<void> {
  let lastError = "not ready";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new UserError(`Gitea did not become ready: ${lastError}`);
}

function assertCommand(
  result: { readonly exitCode: number; readonly stdout?: string; readonly stderr: string },
  action: string
): void {
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}
