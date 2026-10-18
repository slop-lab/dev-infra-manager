import { parseNativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import { parseNativeAttemptAssignment, type NativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import { parseNativeRootCiActiveClaim, type NativeRootCiActiveClaim } from "./nativeRootCiClaimLifecycleProtocol.js";

export function parseStoredActiveClaim(value: string): NativeRootCiActiveClaim {
  return parseNativeRootCiActiveClaim(JSON.parse(value));
}
export function parseStoredAssignment(value: string): NativeAttemptAssignment {
  return parseNativeAttemptAssignment(JSON.parse(value));
}
export function parseStoredIssuance(value: string): NativeRootCiActiveClaim["issuance"] {
  return parseNativeJobAttemptIssuance(JSON.parse(value));
}
export function lifecycleText(row: unknown, name: string): string | undefined {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  return typeof value === "string" ? value : undefined;
}
export function lifecycleInteger(row: unknown, name: string): number {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  return typeof value === "number" ? value : 0;
}
export class NativeRootCiClaimLifecycleStoreError extends Error {
  readonly name = "NativeRootCiClaimLifecycleStoreError";
  constructor() { super("native root CI claim lifecycle state changed during commit"); }
}
