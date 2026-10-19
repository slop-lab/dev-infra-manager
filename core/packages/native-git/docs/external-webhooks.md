# External Git notifications

Native Git's optional private `webhooks` service setting configures operator-owned
subscribers independently of the fixed CI intake. Events describe authoritative
review creation and finalized protected-ref promotion, including Projects with
no CI jobs. This is not a mirror of every Git transport request or a GitHub API.

Add subscribers to the private native Git service configuration before startup:

```json
{
  "webhooks": [{
    "id": "audit-service",
    "endpoint": "https://audit.example.org/dim/events",
    "secret": "whsec_REPLACE_WITH_BASE64_ENCODED_32_RANDOM_BYTES",
    "projects": ["project-a"],
    "events": ["dev.dim.git.review.created", "dev.dim.git.ref.promoted"],
    "maximumAttempts": 8,
    "timeoutMilliseconds": 5000,
    "retryMilliseconds": 1000
  }]
}
```

Generate a separate secret per endpoint with
`node -e 'console.log("whsec_"+require("node:crypto").randomBytes(32).toString("base64"))'`.
Keep the secret/configuration private. Endpoints require HTTPS, except loopback
HTTP for local receivers. User-info, fragments and redirects are rejected.
Project code cannot select endpoints, signing keys or subscriptions. Explicit
Project/event filters are the allowlist. At most 32 subscribers are accepted;
omitting `webhooks` disables this extension.

Payloads follow [CloudEvents 1.0.2 structured JSON](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md):
`specversion: "1.0"`, a durable installation-unique `urn:dim:native-git:UUID` source, deterministic `id`,
`type`, Project/repository `subject`, and metadata-only `data`. Review data includes
review ID, proposal/protected refs, expected/candidate commits, tree, policy
revision and creation time. Promotion data includes finalized transition ID,
sequence, exact expected/candidate commits and decision generation. No patches,
source files, credentials or subscriber addresses are sent.

[Standard Webhooks 1.0.0](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
HMAC-SHA256 signing uses `webhook-id`, `webhook-timestamp` and
`webhook-signature: v1,BASE64`. Verify exact raw bytes against
`ID.TIMESTAMP.RAW_BODY`, with the base64-decoded `whsec_` secret. Check timestamp
freshness and deduplicate event IDs at the receiver. A fresh
`x-dim-webhook-attempt-id` UUID identifies each network attempt. Any 2xx response
acknowledges delivery; no DIM CI receipt or response body is required.

Subscribers have independent durable outbox records and delivery loops.
Requests time out; retries back off exponentially up to 60 seconds. Exhausting
the configured attempt budget marks a delivery failed. Delivery is at-least-once:
a crash after remote acceptance can duplicate an event, retaining the same ID.
Persisted attempts and the source UUID survive restart/backup. Startup backfill, commit
notifications and a five-second reconciliation scan recover the authority-to-
outbox crash window. External failures do not affect CI delivery health,
approval or promotion authority.

Endpoint/filter changes require a new subscriber ID, deliberately backfilling
matching history. Key rotation alone does not replay delivered events. Removing
a subscriber stops its loop and preserves history. Records are retained in
private `external-webhooks.sqlite3` beside the native authority database; include
it in a stopped-service backup.

## Inspection and recovery

Use the Project-owning host-promoter Basic credentials and the current
`x-dim-generation-id` header:

- `GET /v1/projects/PROJECT/webhook-deliveries` returns `healthy` and the newest
  100 delivery summaries: subscriber/event ID, status, attempts, latest attempt
  UUID, next attempt time, HTTP status and sanitized error. No payload, endpoint
  URL or key is returned.
- `POST /v1/projects/PROJECT/webhook-deliveries/SUBSCRIBER/EVENT_ID/retry` with
  JSON `{"requestId":"UUID"}` resets the bounded attempt budget only for an
  exhausted failed delivery. Reusing the request ID is idempotent; applying it
  to another delivery conflicts. Pending, active and delivered records cannot
  be manually reset.

Reviewer/worker roles and another host's promoter cannot inspect or reset these
records. Current activation/generation checks apply to both endpoints. A new
subscriber ID is for intentional destination/filter changes, not outage recovery.
