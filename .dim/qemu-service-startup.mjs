import { chmod, rm } from "node:fs/promises";
import {
  captureSocketIdentity,
  createOwnerRecord,
  createSocketLease,
  publishOwner,
  removeOwnedArtifacts,
  restoreReplacedSocket,
  safeguardReplacedSocket,
  socketLeasePath,
} from "./qemu-service-owner.mjs";
import { activatePreparedRuns, discardPreparedRuns, prepareServiceFilesystem } from "./qemu-service-filesystem.mjs";

export { socketLeasePath };

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function cleanupServiceFilesystem(state) {
  if (!state.socketIdentity) {
    if (state.server.listening) state.server.unref();
    return;
  }
  let protectedSocket;
  try { protectedSocket = await safeguardReplacedSocket(state.socketPath, state.socketIdentity); }
  catch (error) { state.server.unref(); throw error; }
  await closeServer(state.server);
  await restoreReplacedSocket(protectedSocket, state.socketPath);
  if (state.removeRunsRoot) await rm(state.runsRoot, { recursive: true, force: true });
  await removeOwnedArtifacts({ owner: state.ownerIdentity, ownerPath: state.ownerPath,
    preserveSocket: protectedSocket !== undefined, socket: state.socketIdentity, socketPath: state.socketPath });
}

export async function shutdownService(state) {
  await cleanupServiceFilesystem({ ...state, removeRunsRoot: true });
}

export async function initializeService(config) {
  const state = { ...config, ownerIdentity: undefined, preparedRunsRoot: undefined,
    removeRunsRoot: false, socketIdentity: undefined };
  try {
    state.preparedRunsRoot = await prepareServiceFilesystem(config);
    await new Promise((resolve, reject) => {
      config.server.once("error", reject);
      config.server.listen(config.socketPath, resolve);
    });
    state.socketIdentity = await captureSocketIdentity(config.socketPath);
    await createSocketLease(config.socketPath, state.socketIdentity);
    await chmod(socketLeasePath(config.socketPath), 0o666);
    const ownerRecord = await createOwnerRecord(config.socketPath);
    state.ownerIdentity = await publishOwner(config.ownerPath, ownerRecord);
    await activatePreparedRuns(config.runsRoot, state.preparedRunsRoot);
    state.preparedRunsRoot = undefined;
    return { ownerIdentity: state.ownerIdentity, socketIdentity: state.socketIdentity };
  } catch (error) {
    const rollbackErrors = [];
    try {
      await cleanupServiceFilesystem(state);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try { if (state.preparedRunsRoot) await discardPreparedRuns(state.preparedRunsRoot); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "QEMU service startup and rollback failed");
    }
    throw error;
  }
}
