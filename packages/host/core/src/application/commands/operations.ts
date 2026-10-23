import { executeHostOperation } from "../host-application.js";
import type { HostOperationRequest as HostRequest } from "../host-application.js";

/** These calls stay inside the host application. Their domain DTOs are not part
 * of the stable CLI wire protocol. */
export async function runRecordOperation<T = unknown>(request: HostRequest, options: { signal?: AbortSignal } = {}): Promise<T> {
  return await executeHostOperation(request, options.signal) as T;
}
export async function runStreamOperation(request: HostRequest, options: { signal?: AbortSignal; terminal?: boolean } = {}): Promise<number> {
  await executeHostOperation(request, options.signal);
  return Number(process.exitCode ?? 0);
}
