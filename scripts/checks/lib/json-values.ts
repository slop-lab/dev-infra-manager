
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return  (value as Record<string, unknown>);
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a JSON string");
  return value;
}

export function parseJson(text: string): unknown { return JSON.parse(text); }
