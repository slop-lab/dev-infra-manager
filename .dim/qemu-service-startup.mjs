import { chmod, mkdir, rm } from "node:fs/promises";
import {
  captureSocketIdentity,
  createOwnerRecord,
  publishOwner,
  removeIfOwned,
  restoreReplacedSocket,
  safeguardReplacedSocket,
} from "./qemu-service-owner.mjs";

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function rollbackStartup(state) {
  const protectedSocket = state.socketIdentity
    ? await safeguardReplacedSocket(state.socketPath, state.socketIdentity)
    : undefined;
  await closeServer(state.server);
  await restoreReplacedSocket(protectedSocket, state.socketPath);
  const removals = [];
  if (state.ownerIdentity) removals.push(removeIfOwned(state.ownerPath, state.ownerIdentity));
  if (state.socketIdentity) removals.push(removeIfOwned(state.socketPath, state.socketIdentity));
  await Promise.all(removals);
}

export async function initializeService(config) {
  const state = { ...config, ownerIdentity: undefined, socketIdentity: undefined };
  try {
    await new Promise((resolve, reject) => {
      config.server.once("error", reject);
      config.server.listen(config.socketPath, resolve);
    });
    state.socketIdentity = await captureSocketIdentity(config.socketPath);
    await chmod(config.socketPath, 0o666);
    const ownerRecord = await createOwnerRecord(config.socketPath);
    state.ownerIdentity = await publishOwner(config.ownerPath, ownerRecord);
    await rm(config.runsRoot, { recursive: true, force: true });
    await mkdir(config.runsRoot, { mode: 0o700 });
    return { ownerIdentity: state.ownerIdentity, socketIdentity: state.socketIdentity };
  } catch (error) {
    try {
      await rollbackStartup(state);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "QEMU service startup and rollback failed");
    }
    throw error;
  }
}
