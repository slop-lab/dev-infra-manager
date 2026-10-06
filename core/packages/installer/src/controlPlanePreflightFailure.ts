import {
  ControlPlaneImageProbeError,
  ControlPlaneInstallError
} from "./controlPlaneInstallError.js";
import { discardControlPlaneStaging } from "./controlPlaneState.js";

export async function discardControlPlanePreflight(
  lock: Parameters<typeof discardControlPlaneStaging>[0],
  staging: Parameters<typeof discardControlPlaneStaging>[1],
  error: unknown
): Promise<never> {
  const details = error instanceof ControlPlaneImageProbeError ? error.details : undefined;
  try {
    await discardControlPlaneStaging(lock, staging);
  } catch (discardError) {
    throw new ControlPlaneInstallError("control-plane preflight failed and staging cleanup also failed", {
      cause: new AggregateError([error, discardError]),
      ...(details === undefined ? {} : { details })
    });
  }
  throw new ControlPlaneInstallError("control-plane preflight failed before resource mutation", {
    cause: error,
    ...(details === undefined ? {} : { details })
  });
}
