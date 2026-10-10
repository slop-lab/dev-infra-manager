import { once } from "node:events";
import type { Server } from "node:http";
import type { AuthoritativeNativeEventDispatcher } from "./authoritative-native-event-dispatcher.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import { NativeGitBundleServerError } from "./native-bundle-server-types.js";

export function createNativeBundleShutdown(input: {
  readonly server: Server;
  readonly eventDispatcher: AuthoritativeNativeEventDispatcher;
  readonly state: NativeGitBundleState;
  readonly stopAdmission: () => void;
  readonly drainOperations: () => Promise<void>;
}): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      input.stopAdmission();
      let failure: Error | undefined;
      try { await input.drainOperations(); }
      catch (error) {
        failure = error instanceof Error ? error : new NativeGitBundleServerError("native bundle drain failed");
      }
      try { await input.eventDispatcher.close(); }
      catch (error) {
        failure ??= error instanceof Error ? error
          : new NativeGitBundleServerError("authoritative event dispatcher shutdown failed");
      }
      try {
        if (input.server.listening) {
          input.server.close();
          input.server.closeAllConnections();
          await once(input.server, "close");
        }
      } finally {
        await input.state.owner.release();
      }
      if (failure !== undefined) throw failure;
    })();
    return closing;
  };
}
