import { UserError } from "./errors.js";

const UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4
};

export function parseBytes(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input <= 0) {
      throw new UserError(`Invalid byte value: ${input}`);
    }
    return input;
  }

  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)?$/.exec(trimmed);
  if (!match) {
    throw new UserError(`Invalid size: ${input}`);
  }

  const value = Number(match[1]);
  const unit = match[2] ?? "b";
  const multiplier = UNITS[unit];
  if (!multiplier || !Number.isFinite(value) || value <= 0) {
    throw new UserError(`Invalid size: ${input}`);
  }

  const bytes = Math.floor(value * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new UserError(`Invalid size: ${input}`);
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new UserError(`Invalid byte value: ${bytes}`);
  }

  const units = [
    ["TiB", 1024 ** 4],
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024]
  ] as const;

  for (const [unit, divisor] of units) {
    if (bytes >= divisor && bytes % divisor === 0) {
      return `${bytes / divisor}${unit}`;
    }
  }
  return `${bytes}B`;
}
