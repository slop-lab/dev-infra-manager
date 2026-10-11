import { DatabaseSync } from "node:sqlite";

export function completed(file: string): boolean {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT state FROM demands").get()?.state === "completed";
  } finally {
    database.close();
  }
}

export function demandStates(file: string): unknown[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT state FROM demands ORDER BY created_at, demand_id").all().map((row) => row.state);
  } finally {
    database.close();
  }
}

export function centralState(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      results: Number(database.prepare("SELECT count(*) total FROM host_results").get()?.total),
      outbox: database.prepare("SELECT state FROM report_outbox ORDER BY claim_id").all().map((row) => row.state),
      claims: database.prepare("SELECT state FROM claims ORDER BY claim_id").all().map((row) => row.state),
      activeReceipts: Number(database.prepare(`
        SELECT count(*) total FROM claim_receipts WHERE state IN ('preparing','active','reported','recovering')
      `).get()?.total),
      fences: Number(database.prepare("SELECT count(*) total FROM capacity_fences").get()?.total)
    };
  } finally {
    database.close();
  }
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
