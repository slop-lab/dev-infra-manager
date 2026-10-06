import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";

type SqliteSchemaDefinition = {
  readonly schemaSql: string;
  readonly schemaVersion: number;
};

export function assertSqliteSchema(file: string, definition: SqliteSchemaDefinition): string {
  const actual = new DatabaseSync(file, { readOnly: true });
  const expected = expectedDatabase(definition.schemaSql);
  try {
    const actualSignature = schemaSignature(actual);
    const expectedSignature = schemaSignature(expected);
    if (pragmaNumber(actual, "user_version") !== definition.schemaVersion || actualSignature !== expectedSignature) {
      throw new UserError("native ordinary database schema manifest is unsupported");
    }
    const integrity = actual.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || field(integrity[0], "integrity_check") !== "ok"
      || actual.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new UserError("native ordinary database integrity check failed");
    }
    return schemaManifestDigest(actualSignature);
  } finally {
    actual.close();
    expected.close();
  }
}

export function sqliteSchemaManifestSha256(definition: SqliteSchemaDefinition): string {
  const expected = expectedDatabase(definition.schemaSql);
  try {
    if (pragmaNumber(expected, "user_version") !== definition.schemaVersion) {
      throw new UserError("native ordinary schema definition has an inconsistent format version");
    }
    return schemaManifestDigest(schemaSignature(expected));
  } finally {
    expected.close();
  }
}

function expectedDatabase(schemaSql: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(schemaSql);
  return database;
}

function schemaSignature(database: DatabaseSync): string {
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index') ORDER BY type, name
  `).all();
  const tableNames = objects
    .filter((row) => field(row, "type") === "table")
    .map((row) => field(row, "name"))
    .filter((name): name is string => typeof name === "string");
  const metadata = tableNames.map((table) => ({
    table,
    columns: database.prepare(`PRAGMA table_info(${quoted(table)})`).all(),
    indexes: database.prepare(`PRAGMA index_list(${quoted(table)})`).all().map((index) => {
      const name = field(index, "name");
      return { index, columns: typeof name === "string" ? database.prepare(`PRAGMA index_info(${quoted(name)})`).all() : [] };
    }),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all()
  }));
  return JSON.stringify({ objects, metadata }, bigintJson);
}

function pragmaNumber(database: DatabaseSync, name: string): number | undefined {
  const value = field(database.prepare(`PRAGMA ${name}`).get(), name);
  return typeof value === "number" ? value : undefined;
}

function field(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
}

function quoted(identifier: string): string {
  return `'${identifier.replaceAll("'", "''")}'`;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function schemaManifestDigest(signature: string): string {
  return `sha256:${createHash("sha256").update(signature).digest("hex")}`;
}
