import type { DatabaseSync } from "node:sqlite";
import { executionWorkerEnrollmentSecretSchema } from "@slop-lab/dim-contracts-ci/worker";
import { z } from "zod";

const namespace = "execution-scheduler";
const generationIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const workerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const eventIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const executionIdSchema = z.string().uuid();
const metadataRowSchema = z.object({ key: z.string(), value: z.string() }).strict();
export const admissionDiagnosticSchema = z.object({
  phase: z.enum(["authorize", "candidate-read"]),
  code: z.enum(["timeout", "unavailable", "stale"])
}).strict();
export type AdmissionDiagnostic = z.infer<typeof admissionDiagnosticSchema>;
export type WorkerEnrollment = ReturnType<typeof executionWorkerEnrollmentSecretSchema.parse>;

const enrollmentPrefix = `${namespace}/enrollment/`;
const admissionPrefix = `${namespace}/admission/`;

export function workerEnrollmentMetadataKey(generationId: string, workerId: string): string {
  return `${enrollmentPrefix}${generationIdSchema.parse(generationId)}/${workerIdSchema.parse(workerId)}`;
}

export function admissionMetadataKey(generationId: string, eventId: string, executionId: string): string {
  return `${admissionPrefix}${generationIdSchema.parse(generationId)}/${eventIdSchema.parse(eventId)}/${executionIdSchema.parse(executionId)}`;
}

export function readWorkerEnrollments(database: DatabaseSync): readonly WorkerEnrollment[] {
  return database.prepare("SELECT key,value FROM metadata WHERE key LIKE ? ORDER BY key")
    .all(`${enrollmentPrefix}%`).map((row) => {
      const metadata = metadataRowSchema.parse(row);
      const enrollment = executionWorkerEnrollmentSecretSchema.parse(JSON.parse(metadata.value));
      if (metadata.key !== workerEnrollmentMetadataKey(enrollment.generationId, enrollment.workerId)) {
        throw new Error("enrolled worker metadata identity is invalid");
      }
      return enrollment;
    });
}

export function readAdmissionDiagnostic(database: DatabaseSync, identity: {
  readonly generationId: string;
  readonly eventId: string;
  readonly executionId: string;
}): AdmissionDiagnostic | undefined {
  const row = database.prepare("SELECT key,value FROM metadata WHERE key=?")
    .get(admissionMetadataKey(identity.generationId, identity.eventId, identity.executionId));
  if (row === undefined) return undefined;
  const metadata = metadataRowSchema.parse(row);
  return admissionDiagnosticSchema.parse(JSON.parse(metadata.value));
}

export function validateAdmissionDiagnostics(database: DatabaseSync): void {
  for (const row of database.prepare("SELECT key,value FROM metadata WHERE key LIKE ? ORDER BY key").all(`${admissionPrefix}%`)) {
    const metadata = metadataRowSchema.parse(row);
    const segments = metadata.key.slice(admissionPrefix.length).split("/");
    if (segments.length !== 3) throw new Error("execution admission metadata identity is invalid");
    admissionMetadataKey(segments[0] ?? "", segments[1] ?? "", segments[2] ?? "");
    admissionDiagnosticSchema.parse(JSON.parse(metadata.value));
  }
}

export function writeAdmissionDiagnostic(database: DatabaseSync, identity: {
  readonly generationId: string;
  readonly eventId: string;
  readonly executionId: string;
}, diagnostic: AdmissionDiagnostic): void {
  database.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(admissionMetadataKey(identity.generationId, identity.eventId, identity.executionId), JSON.stringify(admissionDiagnosticSchema.parse(diagnostic)));
}
