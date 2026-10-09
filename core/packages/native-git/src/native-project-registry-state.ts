import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const hostIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const registrationInput = z.object({
  serviceId: z.literal("native-main"),
  projectId: identifier,
  rootRepositoryId: identifier,
  ownerHostId: hostIdentifier
}).strict().readonly();
const storedRegistration = z.object({
  serviceId: z.literal("native-main"),
  projectId: identifier,
  rootRepositoryId: identifier,
  ownerHostId: hostIdentifier,
  provisioningNonce: z.string().uuid(),
  phase: z.union([z.literal("provisioning"), z.literal("root-prepared")])
}).strict().readonly();

export const nativeProjectRegistrationSchema = `CREATE TABLE native_project_registration (
  service_id TEXT NOT NULL CHECK (service_id = 'native-main'),
  project_id TEXT PRIMARY KEY
    CHECK (length(project_id) BETWEEN 1 AND 64
      AND project_id NOT GLOB '*[^a-z0-9-]*'
      AND substr(project_id, 1, 1) GLOB '[a-z0-9]'
      AND substr(project_id, -1, 1) GLOB '[a-z0-9]'),
  root_repository_id TEXT NOT NULL
    CHECK (length(root_repository_id) BETWEEN 1 AND 64
      AND root_repository_id NOT GLOB '*[^a-z0-9-]*'
      AND substr(root_repository_id, 1, 1) GLOB '[a-z0-9]'
      AND substr(root_repository_id, -1, 1) GLOB '[a-z0-9]'),
  owner_host_id TEXT NOT NULL
    CHECK (length(owner_host_id) BETWEEN 1 AND 128
      AND owner_host_id NOT GLOB '*[^a-z0-9._-]*'
      AND substr(owner_host_id, 1, 1) GLOB '[a-z0-9]'),
  provisioning_nonce TEXT NOT NULL UNIQUE CHECK (length(provisioning_nonce) = 36),
  phase TEXT NOT NULL CHECK (phase IN ('provisioning', 'root-prepared'))
) STRICT`;

export type NativeProjectRegistration = z.infer<typeof storedRegistration>;

export function registerNativeProjectInDatabase(databasePath: string, generationId: string, input: unknown): void {
  if (!/^[0-9a-f]{64}$/.test(generationId)) {
    throw new NativeProjectRegistrationStateError("native Project registration requires an exact activation generation");
  }
  const registration = parseRegistrationInput(input);
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA synchronous = FULL");
    assertActivatedGeneration(database, generationId);
    const existing = selectRegistration(database, registration.projectId);
    if (existing !== undefined) {
      assertSameRegistration(existing, registration);
      return;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      assertActivatedGeneration(database, generationId);
      const concurrent = selectRegistration(database, registration.projectId);
      if (concurrent === undefined) {
        database.prepare(`INSERT INTO native_project_registration
          (service_id, project_id, root_repository_id, owner_host_id, provisioning_nonce, phase)
          VALUES (?, ?, ?, ?, ?, 'provisioning')`
        ).run(registration.serviceId, registration.projectId, registration.rootRepositoryId,
          registration.ownerHostId, randomUUID());
      } else {
        assertSameRegistration(concurrent, registration);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function assertActivatedGeneration(database: DatabaseSync, generationId: string): void {
  if (database.prepare("SELECT 1 FROM bundle_activation WHERE generation_id = ?").get(generationId) === undefined) {
    throw new NativeProjectRegistrationStateError("native Project registration requires activation of the expected generation");
  }
}

export function readNativeProjectRegistrationsFromDatabase(
  databasePath: string
): readonly NativeProjectRegistration[] {
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    return parseRows(database.prepare(`SELECT service_id, project_id, root_repository_id, owner_host_id,
      provisioning_nonce, phase
      FROM native_project_registration ORDER BY project_id`).all());
  } finally {
    database.close();
  }
}

export function assertNativeProjectRegistrationRows(database: DatabaseSync): readonly NativeProjectRegistration[] {
  return parseRows(database.prepare(`SELECT service_id, project_id, root_repository_id, owner_host_id,
    provisioning_nonce, phase
    FROM native_project_registration ORDER BY project_id`).all());
}

export function selectRegistration(
  database: DatabaseSync,
  projectId: string
): NativeProjectRegistration | undefined {
  const row = database.prepare(`SELECT service_id, project_id, root_repository_id, owner_host_id,
    provisioning_nonce, phase
    FROM native_project_registration WHERE project_id = ?`).get(projectId);
  return row === undefined ? undefined : parseRegistrationRow(row);
}

export function parseRegistration(value: unknown): NativeProjectRegistration {
  const result = storedRegistration.safeParse(value);
  if (!result.success) {
    throw new NativeProjectRegistrationStateError("native Project registration is invalid", { cause: result.error });
  }
  return result.data;
}

export function beginNativeProjectPreparation(
  databasePath: string,
  generationId: string,
  input: unknown
): NativeProjectRegistration {
  registerNativeProjectInDatabase(databasePath, generationId, input);
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    const requested = parseRegistrationInput(input);
    const registration = selectRegistration(database, requested.projectId);
    if (registration === undefined) throw new NativeProjectRegistrationStateError("native Project is not registered");
    return registration;
  } finally {
    database.close();
  }
}

export function completeNativeProjectPreparation(
  databasePath: string,
  generationId: string,
  projectId: string
): NativeProjectRegistration {
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    try {
      assertActivatedGeneration(database, generationId);
      database.prepare("UPDATE native_project_registration SET phase = 'root-prepared' WHERE project_id = ?")
        .run(projectId);
      const registration = selectRegistration(database, projectId);
      if (registration === undefined) throw new NativeProjectRegistrationStateError("native Project is not registered");
      database.exec("COMMIT");
      return registration;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function assertSameRegistration(
  existing: NativeProjectRegistration,
  requested: z.infer<typeof registrationInput>
): void {
  if (existing.ownerHostId !== requested.ownerHostId) {
    throw new NativeProjectRegistrationHostMismatchError();
  }
  if (existing.serviceId !== requested.serviceId || existing.rootRepositoryId !== requested.rootRepositoryId) {
    throw new NativeProjectRegistrationConflictError(requested.projectId);
  }
}

function parseRows(rows: readonly unknown[]): readonly NativeProjectRegistration[] {
  return rows.map(parseRegistrationRow);
}

function parseRegistrationRow(row: unknown): NativeProjectRegistration {
  if (!isRecord(row)) throw new NativeProjectRegistrationStateError("native Project registration row is invalid");
  return parseRegistration({
    serviceId: row.service_id, projectId: row.project_id,
    rootRepositoryId: row.root_repository_id, ownerHostId: row.owner_host_id,
    provisioningNonce: row.provisioning_nonce, phase: row.phase
  });
}

function parseRegistrationInput(value: unknown): z.infer<typeof registrationInput> {
  const result = registrationInput.safeParse(value);
  if (!result.success) {
    throw new NativeProjectRegistrationStateError("native Project registration is invalid", { cause: result.error });
  }
  return result.data;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NativeProjectRegistrationStateError extends Error {
  readonly name = "NativeProjectRegistrationStateError";
}

export class NativeProjectRegistrationConflictError extends Error {
  readonly name = "NativeProjectRegistrationConflictError";
  constructor(readonly projectId: string) {
    super(`native Project '${projectId}' registration conflicts with durable state`);
  }
}

export class NativeProjectRegistrationHostMismatchError extends Error {
  readonly name = "NativeProjectRegistrationHostMismatchError";

  constructor() {
    super("native Project registration host does not match");
  }
}
