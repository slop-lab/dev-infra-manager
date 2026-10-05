import type { NativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";

export async function submitNativeResult(
  reportResult: (request: NativeHostResultRequest, signal: AbortSignal) => Promise<void>,
  request: NativeHostResultRequest,
  signal: AbortSignal
): Promise<Error | undefined> {
  let failure: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await reportResult(request, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      return undefined;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
    }
  }
  return failure;
}
