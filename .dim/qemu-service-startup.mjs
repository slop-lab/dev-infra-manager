import { chmod, rm } from "node:fs/promises";
import {
  captureSocketIdentity,
  createSocketLease,
  publishOwner,
  removeOwnedArtifacts,
  restoreSocketFromLease,
  restoreReplacedSocket,
  safeguardReplacedSocket,
  socketLeasePath,
} from "./qemu-service-artifacts.mjs";
import { createOwnerRecord } from "./qemu-service-owner.mjs";
import { activatePreparedRuns, discardPreparedRuns, prepareServiceFilesystem } from "./qemu-service-filesystem.mjs";

export { socketLeasePath };

export async function closeServiceListener(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

export async function closeServiceListenerPreservingSocket(state) {
  let protectedSocket;
  try { protectedSocket = await safeguardReplacedSocket(state.socketPath, state.socketIdentity); }
  catch (error) { state.server.unref(); throw error; }
  await closeServiceListener(state.server);
  if (protectedSocket) await restoreReplacedSocket(protectedSocket, state.socketPath);
  else await restoreSocketFromLease(state.socketPath, state.socketIdentity);
}

async function cleanupServiceFilesystem(state) {
  if (!state.socketIdentity) {
    if (state.server.listening) state.server.unref();
    return;
  }
  let protectedSocket;
  try { protectedSocket = await safeguardReplacedSocket(state.socketPath, state.socketIdentity); }
  catch (error) { state.server.unref(); throw error; }
  await closeServiceListener(state.server);
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
  let initializationError;
  const onInitializationError = (error) => { initializationError = error; };
  try {
    state.preparedRunsRoot = await prepareServiceFilesystem(config);
    await new Promise((resolve, reject) => {
      const onStartupError = (error) => reject(error);
      config.server.once("error", onStartupError);
      config.server.listen(config.socketPath, () => {
        config.server.on("error", onInitializationError);
        config.server.off("error", onStartupError);
        resolve();
      });
    });
    state.socketIdentity = await captureSocketIdentity(config.socketPath);
    await createSocketLease(config.socketPath, state.socketIdentity);
    if (initializationError) throw initializationError;
    await chmod(socketLeasePath(config.socketPath), 0o666);
    if (initializationError) throw initializationError;
    const ownerRecord = await createOwnerRecord(config.socketPath);
    if (initializationError) throw initializationError;
    state.ownerIdentity = await publishOwner(config.ownerPath, ownerRecord);
    if (initializationError) throw initializationError;
    await activatePreparedRuns(config.runsRoot, state.preparedRunsRoot);
    if (initializationError) throw initializationError;
    state.preparedRunsRoot = undefined;
    config.server.on("error", config.onRuntimeError);
    config.server.off("error", onInitializationError);
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
    config.server.off("error", onInitializationError);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "QEMU service startup and rollback failed");
    }
    throw error;
  }
}
