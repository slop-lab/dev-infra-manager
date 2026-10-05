import { UserError } from "./errors.js";

export type NativeAdmissionRow = {
  readonly admissionGeneration: string;
  readonly policyDigest: string;
  readonly capacityConfigDigest: string;
  readonly expiresAt: number;
};

export function admissionRow(value: unknown): NativeAdmissionRow | undefined {
  if (value === undefined) return undefined;
  const admissionGeneration = stringField(value, "admission_generation");
  const policyDigest = stringField(value, "policy_digest");
  const capacityConfigDigest = stringField(value, "capacity_config_digest");
  const expiresAt = numberField(value, "expires_at");
  if (admissionGeneration === undefined || policyDigest === undefined || capacityConfigDigest === undefined
    || expiresAt === undefined) throw new UserError("native ordinary database contains an invalid admission row");
  return { admissionGeneration, policyDigest, capacityConfigDigest, expiresAt };
}

export function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = Reflect.get(value, field);
  return typeof result === "string" ? result : undefined;
}

export function numberField(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = Reflect.get(value, field);
  return typeof result === "number" && Number.isSafeInteger(result) ? result : undefined;
}

export function requiredClaimString(value: unknown, field: string): string {
  const result = stringField(value, field);
  if (result === undefined) throw new UserError("native ordinary database contains an invalid claim row");
  return result;
}

export function requiredClaimNumber(value: unknown, field: string): number {
  const result = numberField(value, field);
  if (result === undefined) throw new UserError("native ordinary database contains an invalid claim row");
  return result;
}
