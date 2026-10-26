import { setTimeout as delay } from "node:timers/promises";
import { UserError } from "../errors.js";
import type { openWorkspaceServiceChannel } from "./serviceChannel.js";

export async function maintainWorkspaceServiceChannel(options: {
  readonly open: () => ReturnType<typeof openWorkspaceServiceChannel>;
  readonly signal: AbortSignal;
  readonly ready: (port: number) => Promise<void>;
  readonly disconnected: () => void;
  readonly report: (message: string) => void;
}): Promise<void> {
  while (!options.signal.aborted) {
    const channel = options.open();
    try {
      const port = await channel.ready;
      await options.ready(port);
      await channel.closed;
    } catch (error) {
      if (!options.signal.aborted) options.report(error instanceof UserError ? error.message : "runtime connection unavailable");
    } finally {
      options.disconnected();
      try { await channel.close(); }
      catch (error) { if (!options.signal.aborted) options.report(error instanceof UserError ? error.message : "runtime cleanup unavailable"); }
    }
    if (!options.signal.aborted) {
      try { await delay(500, undefined, { signal: options.signal }); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  }
}
