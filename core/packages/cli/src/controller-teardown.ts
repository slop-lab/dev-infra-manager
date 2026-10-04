import type { Server } from "node:http";
import { UserError, type RegisteredDimPlugins } from "@slop-lab/dim-core";

const connectionGraceMilliseconds = 500;
const forcedCloseMilliseconds = 1_000;
const pluginDisposeMilliseconds = 1_000;

export async function closeControllerServers(
  servers: readonly (Server | undefined)[]
): Promise<void> {
  const listening = servers.filter((server): server is Server => server?.listening === true);
  const closed = Promise.all(listening.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }))).then(() => undefined);
  for (const server of listening) server.closeIdleConnections();
  if (await completesWithin(closed, connectionGraceMilliseconds)) return;
  for (const server of listening) server.closeAllConnections();
  if (!await completesWithin(closed, forcedCloseMilliseconds)) {
    void closed.catch(() => undefined);
    throw new UserError("controller listeners did not close within the shutdown deadline");
  }
}

export async function disposeControllerPlugins(
  plugins: Pick<RegisteredDimPlugins, "dispose"> | undefined
): Promise<boolean> {
  if (plugins === undefined) return true;
  const disposal = plugins.dispose();
  if (await completesWithin(disposal, pluginDisposeMilliseconds)) return true;
  void disposal.catch((error) => console.error("DIM plugin disposal failed after shutdown deadline", error));
  return false;
}

async function completesWithin(operation: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
