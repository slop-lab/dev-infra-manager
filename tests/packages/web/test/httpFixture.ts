export type JsonObject = Readonly<Record<string, unknown>>;

export function reviewPath(suffix = ""): string {
  return `/v1/projects/project-a/repositories/root/reviews${suffix}`;
}

export async function readJsonObject(response: Response): Promise<JsonObject> {
  return parseJsonObject(await response.text());
}

export function parseJsonObject(input: string): JsonObject {
  const value: unknown = JSON.parse(input);
  if (!isJsonObject(value)) throw new Error("expected JSON object");
  return value;
}

export function stringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`expected string field: ${field}`);
  return candidate;
}

export function stringArrayField(value: JsonObject, field: string): readonly string[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || !candidate.every((entry) => typeof entry === "string")) {
    throw new Error(`expected string array field: ${field}`);
  }
  return candidate;
}

export function objectArrayField(value: JsonObject, field: string): readonly JsonObject[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || !candidate.every(isJsonObject)) {
    throw new Error(`expected object array field: ${field}`);
  }
  return candidate;
}

export function objectField(value: JsonObject, field: string): JsonObject {
  const candidate = value[field];
  if (!isJsonObject(candidate)) throw new Error(`expected object field: ${field}`);
  return candidate;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
