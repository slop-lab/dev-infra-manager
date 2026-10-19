import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const registrationInput = z.object({ serviceId: z.literal("native-main"), projectId: identifier,
  repositoryId: identifier, ownerHostId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/) }).strict().readonly();
const storedRegistration = registrationInput.unwrap().extend({ provisioningNonce: z.string().uuid(),
  phase: z.enum(["provisioning", "repository-prepared"]) }).readonly();
export type NativeProjectRegistration = z.infer<typeof storedRegistration>;

export const nativeProjectRegistrationSchema = `CREATE TABLE native_project_registration (
  service_id TEXT NOT NULL CHECK (service_id = 'native-main'),
  project_id TEXT PRIMARY KEY CHECK (length(project_id) BETWEEN 1 AND 64 AND project_id NOT GLOB '*[^a-z0-9-]*'
    AND substr(project_id, 1, 1) GLOB '[a-z0-9]' AND substr(project_id, -1, 1) GLOB '[a-z0-9]'),
  owner_host_id TEXT NOT NULL CHECK (length(owner_host_id) BETWEEN 1 AND 128
    AND owner_host_id NOT GLOB '*[^a-z0-9._-]*' AND substr(owner_host_id, 1, 1) GLOB '[a-z0-9]'),
  provisioning_nonce TEXT NOT NULL UNIQUE CHECK (length(provisioning_nonce) = 36)
) STRICT`;
export const nativeRepositoryRegistrationSchema = `CREATE TABLE native_repository_registration (
  project_id TEXT NOT NULL REFERENCES native_project_registration(project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 64 AND repository_id NOT GLOB '*[^a-z0-9-]*'
    AND substr(repository_id, 1, 1) GLOB '[a-z0-9]' AND substr(repository_id, -1, 1) GLOB '[a-z0-9]'),
  phase TEXT NOT NULL CHECK (phase IN ('provisioning', 'repository-prepared')),
  PRIMARY KEY (project_id, repository_id)
) STRICT`;
const selection = `SELECT p.service_id, p.project_id, r.repository_id, p.owner_host_id, p.provisioning_nonce, r.phase
  FROM native_project_registration p JOIN native_repository_registration r ON p.project_id = r.project_id`;

export function assertActivatedGeneration(database: DatabaseSync, generationId: string): void {
  if (!/^[0-9a-f]{64}$/.test(generationId) || database.prepare("SELECT 1 FROM bundle_activation WHERE generation_id = ?").get(generationId) === undefined) {
    throw new NativeProjectRegistrationStateError("native repository registration requires activation of the expected generation");
  }
}
export function registerNativeProjectInDatabase(databasePath: string, generationId: string, input: unknown): void {
  const requested = parseRegistrationInput(input);
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    try {
      assertActivatedGeneration(database, generationId);
      const project = database.prepare("SELECT service_id, owner_host_id FROM native_project_registration WHERE project_id = ?").get(requested.projectId);
      if (project !== undefined) {
        if (project.owner_host_id !== requested.ownerHostId) throw new NativeProjectRegistrationHostMismatchError();
        if (project.service_id !== requested.serviceId) throw new NativeProjectRegistrationConflictError(requested.projectId);
      } else {
        database.prepare("INSERT INTO native_project_registration (service_id, project_id, owner_host_id, provisioning_nonce) VALUES (?, ?, ?, ?)")
          .run(requested.serviceId, requested.projectId, requested.ownerHostId, randomUUID());
      }
      const existing = selectRegistration(database, requested.projectId, requested.repositoryId);
      if (existing) assertSameRegistration(existing, requested);
      else database.prepare("INSERT INTO native_repository_registration (project_id, repository_id, phase) VALUES (?, ?, 'provisioning')")
        .run(requested.projectId, requested.repositoryId);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  } finally { database.close(); }
}
export function readNativeProjectRegistrationsFromDatabase(databasePath: string): readonly NativeProjectRegistration[] {
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try { return assertNativeProjectRegistrationRows(database); } finally { database.close(); }
}
export function assertNativeProjectRegistrationRows(database: DatabaseSync): readonly NativeProjectRegistration[] {
  const orphan = database.prepare("SELECT 1 FROM native_project_registration p WHERE NOT EXISTS (SELECT 1 FROM native_repository_registration r WHERE r.project_id = p.project_id)").get();
  if (orphan || database.prepare("PRAGMA foreign_key_check").all().length) throw new NativeProjectRegistrationStateError("native Project repository registration binding is invalid");
  return database.prepare(`${selection} ORDER BY p.project_id, r.repository_id`).all().map(parseRegistrationRow);
}
export function selectRegistration(database: DatabaseSync, projectId: string, repositoryId: string): NativeProjectRegistration | undefined {
  const row = database.prepare(`${selection} WHERE p.project_id = ? AND r.repository_id = ?`).get(projectId, repositoryId);
  return row === undefined ? undefined : parseRegistrationRow(row);
}
export function parseRegistration(value: unknown): NativeProjectRegistration {
  const result = storedRegistration.safeParse(value);
  if (!result.success) throw new NativeProjectRegistrationStateError("native repository registration is invalid", { cause: result.error });
  return result.data;
}
export function beginNativeProjectPreparation(databasePath: string, generationId: string, input: unknown): NativeProjectRegistration {
  const requested = parseRegistrationInput(input);
  registerNativeProjectInDatabase(databasePath, generationId, requested);
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    const registration = selectRegistration(database, requested.projectId, requested.repositoryId);
    if (!registration) throw new NativeProjectRegistrationStateError("native repository is not registered");
    return registration;
  } finally { database.close(); }
}
export function completeNativeProjectPreparation(databasePath: string, generationId: string, projectId: string, repositoryId: string): NativeProjectRegistration {
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    try {
      assertActivatedGeneration(database, generationId);
      database.prepare("UPDATE native_repository_registration SET phase = 'repository-prepared' WHERE project_id = ? AND repository_id = ?").run(projectId, repositoryId);
      const result = selectRegistration(database, projectId, repositoryId);
      if (!result) throw new NativeProjectRegistrationStateError("native repository is not registered");
      database.exec("COMMIT"); return result;
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  } finally { database.close(); }
}
export function assertSameRegistration(existing: NativeProjectRegistration, requested: z.infer<typeof registrationInput>): void {
  if (existing.ownerHostId !== requested.ownerHostId) throw new NativeProjectRegistrationHostMismatchError();
  if (existing.serviceId !== requested.serviceId || existing.projectId !== requested.projectId || existing.repositoryId !== requested.repositoryId) throw new NativeProjectRegistrationConflictError(requested.projectId);
}
function parseRegistrationInput(value: unknown): z.infer<typeof registrationInput> {
  const result = registrationInput.safeParse(value);
  if (!result.success) throw new NativeProjectRegistrationStateError("native repository registration is invalid", { cause: result.error });
  return result.data;
}
function parseRegistrationRow(row: Record<string, unknown>): NativeProjectRegistration {
  return parseRegistration({ serviceId: row.service_id, projectId: row.project_id, repositoryId: row.repository_id,
    ownerHostId: row.owner_host_id, provisioningNonce: row.provisioning_nonce, phase: row.phase });
}
export class NativeProjectRegistrationStateError extends Error { readonly name = "NativeProjectRegistrationStateError"; }
export class NativeProjectRegistrationConflictError extends Error {
  readonly name = "NativeProjectRegistrationConflictError";
  constructor(readonly projectId: string) { super(`native Project '${projectId}' registration conflicts with durable state`); }
}
export class NativeProjectRegistrationHostMismatchError extends Error {
  readonly name = "NativeProjectRegistrationHostMismatchError";
  constructor() { super("native Project registration host does not match"); }
}
