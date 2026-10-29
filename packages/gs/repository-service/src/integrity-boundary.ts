import type { DatabaseSync } from "node:sqlite";
import { RepositoryStateError } from "./state.js";

export class RepositoryStateIntegrityBoundary {
  readonly #database: DatabaseSync;
  readonly #dataVersion: number;

  constructor(database: DatabaseSync) {
    this.#database = database;
    this.#dataVersion = readDataVersion(database);
  }

  assertUnchanged(): void {
    if (readDataVersion(this.#database) !== this.#dataVersion) {
      throw new RepositoryStateError("repository state changed outside the live authority owner");
    }
  }
}

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get();
  if (!isRecord(row) || typeof row.data_version !== "number" || !Number.isSafeInteger(row.data_version)) {
    throw new RepositoryStateError("repository state data version is invalid");
  }
  return row.data_version;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
