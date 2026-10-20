import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { externalWebhookEventTypeSchema } from "./external-webhook-config.js";
import type { ExternalWebhookSubscriber } from "./external-webhook-config.js";

const sourceSchema = z.string().regex(/^urn:dim:webhooks:[0-9a-f-]{36}$/);
export const externalWebhookEventSchema = z.object({
  specversion: z.literal("1.0"), id: z.string().regex(/^[0-9a-f]{64}$/),
  source: sourceSchema,
  type: externalWebhookEventTypeSchema,
  subject: z.string().min(1), datacontenttype: z.literal("application/json"),
  data: z.record(z.string(), z.union([z.string(), z.number()])).readonly()
}).strict().readonly();
export type ExternalWebhookEvent = z.infer<typeof externalWebhookEventSchema>;
const deliverySchema = z.object({
  subscriberId: z.string(), eventId: z.string(), projectId: z.string(),
  status: z.enum(["pending", "delivering", "delivered", "failed"]), attempts: z.number(),
  attemptId: z.string().nullable(), nextAttemptAt: z.number(), lastStatus: z.number().nullable(),
  lastError: z.string().nullable()
}).strict().readonly();
export type ExternalWebhookDelivery = z.infer<typeof deliverySchema>;
const projection = `subscriber_id AS subscriberId, event_id AS eventId, project_id AS projectId,
  status, attempts, attempt_id AS attemptId, next_at AS nextAttemptAt,
  last_status AS lastStatus, last_error AS lastError`;

/** One writer is protected by the webhook plugin state-directory lease. */
export class ExternalWebhookStore {
  private readonly database: DatabaseSync;
  readonly source: string;
  constructor(path: string) {
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || metadata.uid !== process.getuid?.()) throw new Error("external webhook database must be a private owned file");
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    this.database = new DatabaseSync(path, { defensive: true });
    try {
      chmodSync(path, 0o600);
      this.database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS deliveries (
          subscriber_id TEXT NOT NULL, event_id TEXT NOT NULL, project_id TEXT NOT NULL,
          binding TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, attempt_id TEXT, next_at INTEGER NOT NULL DEFAULT 0,
          last_status INTEGER, last_error TEXT, PRIMARY KEY(subscriber_id,event_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS pending_webhooks ON deliveries(status,next_at);
        CREATE TABLE IF NOT EXISTS retry_requests (
          request_id TEXT PRIMARY KEY, subscriber_id TEXT NOT NULL, event_id TEXT NOT NULL,
          project_id TEXT NOT NULL
        ) STRICT;`);
      this.database.prepare("INSERT OR IGNORE INTO metadata VALUES ('source',?)").run(`urn:dim:webhooks:${randomUUID()}`);
      const metadata = this.database.prepare("SELECT value FROM metadata WHERE key='source'").get();
      this.source = sourceSchema.parse(metadata?.value);
      // An interrupted network request has an unknown remote outcome. Retry the same event id;
      // its persisted attempt already consumed the bounded automatic attempt budget.
      this.database.exec("UPDATE deliveries SET status='pending' WHERE status='delivering'");
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) { this.database.close(); throw error; }
  }
  assertBinding(subscriber: ExternalWebhookSubscriber): void {
    const row = this.database.prepare("SELECT binding FROM deliveries WHERE subscriber_id=? LIMIT 1").get(subscriber.id);
    if (row !== undefined && row.binding !== binding(subscriber)) {
      throw new Error(`external webhook '${subscriber.id}' endpoint/filters changed; use a new subscriber id`);
    }
  }
  close(): void { this.database.close(); }
  enqueue(subscriber: ExternalWebhookSubscriber, projectId: string, event: ExternalWebhookEvent): void {
    this.database.prepare(`INSERT OR IGNORE INTO deliveries
      (subscriber_id,event_id,project_id,binding,body,status) VALUES (?,?,?,?,?,'pending')`)
      .run(subscriber.id, event.id, projectId, binding(subscriber), JSON.stringify(event));
  }
  list(projectId: string): readonly ExternalWebhookDelivery[] {
    return this.database.prepare(`SELECT ${projection} FROM deliveries WHERE project_id=?
      ORDER BY rowid DESC LIMIT 100`).all(projectId).map((row) => deliverySchema.parse(row));
  }
  claim(subscriber: ExternalWebhookSubscriber, now: number): {
    readonly delivery: ExternalWebhookDelivery; readonly body: string;
  } | undefined {
    this.database.prepare(`UPDATE deliveries SET status='failed',last_error='automatic attempt budget exhausted'
      WHERE subscriber_id=? AND status='pending' AND attempts>=?`).run(subscriber.id, subscriber.maximumAttempts);
    const row = this.database.prepare(`SELECT ${projection},body FROM deliveries
      WHERE subscriber_id=? AND binding=? AND status='pending' AND next_at<=? AND attempts<? ORDER BY rowid LIMIT 1`)
      .get(subscriber.id, binding(subscriber), now, subscriber.maximumAttempts);
    if (row === undefined) return undefined;
    const { body, ...metadata } = row;
    if (typeof body !== "string") throw new Error("invalid external webhook body");
    const delivery = deliverySchema.parse(metadata);
    externalWebhookEventSchema.parse(JSON.parse(body));
    const attemptId = randomUUID();
    this.database.prepare(`UPDATE deliveries SET status='delivering',attempts=attempts+1,attempt_id=?
      WHERE subscriber_id=? AND event_id=?`).run(attemptId, subscriber.id, delivery.eventId);
    return { delivery: { ...delivery, status: "delivering", attempts: delivery.attempts + 1, attemptId }, body };
  }
  finish(subscriber: ExternalWebhookSubscriber, delivery: ExternalWebhookDelivery,
    status: number | null, error: string | null): void {
    const success = status !== null && status >= 200 && status < 300;
    this.database.prepare(`UPDATE deliveries SET status=?,next_at=?,last_status=?,last_error=?
      WHERE subscriber_id=? AND event_id=? AND attempt_id=? AND status='delivering'`)
      .run(success ? "delivered" : delivery.attempts >= subscriber.maximumAttempts ? "failed" : "pending",
        Date.now() + Math.min(60_000, subscriber.retryMilliseconds * 2 ** Math.min(delivery.attempts - 1, 10)),
        status, error?.slice(0, 512) ?? null, subscriber.id, delivery.eventId, delivery.attemptId);
  }
  retry(projectId: string, subscriber: ExternalWebhookSubscriber, eventId: string, requestId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.database.prepare("SELECT * FROM retry_requests WHERE request_id=?").get(requestId);
      if (replay !== undefined) {
        if (replay.subscriber_id !== subscriber.id || replay.event_id !== eventId || replay.project_id !== projectId) {
          throw new Error("retry request id conflicts with an earlier request");
        }
      } else {
        const updated = this.database.prepare(`UPDATE deliveries SET status='pending',attempts=0,next_at=0,last_error=NULL
          WHERE subscriber_id=? AND event_id=? AND project_id=? AND binding=? AND status='failed'`)
          .run(subscriber.id, eventId, projectId, binding(subscriber));
        if (updated.changes !== 1) throw new Error("only an exhausted failed delivery can be retried");
        this.database.prepare("INSERT INTO retry_requests VALUES (?,?,?,?)")
          .run(requestId, subscriber.id, eventId, projectId);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function binding(subscriber: ExternalWebhookSubscriber): string {
  // Secret rotation does not replay history. Endpoint/filter changes require a new subscriber id.
  return createHash("sha256").update(JSON.stringify([subscriber.endpoint, [...subscriber.projects].sort(), [...subscriber.events].sort()])).digest("hex");
}
