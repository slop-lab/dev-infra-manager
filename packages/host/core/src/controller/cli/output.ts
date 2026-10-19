export interface JsonFlags { json?: boolean }

export function print(value: unknown, flags: JsonFlags = {}): void {
  if (flags.json || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

export function printActionResult(value: unknown, flags: JsonFlags, message: string): void {
  if (flags.json) print(value, flags);
  else console.log(message);
}

export function printList<T extends object>(records: T[], fields: string[], flags: JsonFlags = {}): void {
  if (flags.json) {
    print(records, flags);
    return;
  }
  if (records.length === 0) return;
  console.table(records.map((record) => {
    const values = record as Record<string, unknown>;
    return Object.fromEntries(fields.map((field) => [field, values[field] ?? ""]));
  }));
}
