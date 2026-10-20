# Webhooks

`@slop-lab/dim-control-plane-plugin-webhooks` is an optional control-plane
transport. It can consume any installed durable event-source contribution;
it does not require Git, human review, merge policy or CI. Producers expose
`{kind:"dim.webhooks.event-source", name, value:{name, read}}` descriptors.
`read()` returns durable events with `identity`, `projectId`, `type`, `subject`
and scalar metadata `data`. The public `/extensions` types and helper are
optional conveniences; structurally compatible producers need no package
runtime dependency. A `subscribeWake` callback is an optional latency hint;
startup backfill and periodic durable scans remain authoritative.

Configure the plugin through a private control-plane service file:

```json
{
  "schemaVersion": 1,
  "stateDirectory": "/var/lib/dim-webhooks",
  "generationId": "CURRENT_64_HEX_GENERATION",
  "sources": ["code-review", "merge-policy"],
  "subscribers": [{
    "id": "audit",
    "endpoint": "https://receiver.example/events",
    "secret": "whsec_BASE64_OF_32_RANDOM_BYTES",
    "projects": ["project"],
    "events": ["dev.dim.git.review.created", "dev.dim.git.ref.promoted"]
  }],
  "operators": [{
    "username": "auditor",
    "password": "REPLACE_WITH_A_PRIVATE_RANDOM_PASSWORD_AT_LEAST_32_CHARACTERS",
    "projects": ["project"]
  }],
  "listen": {"host": "127.0.0.1", "port": 8081}
}
```

The generation and signing-key placeholders must be replaced before validation.
Every configured source must be installed. Subscriber URLs and signing keys
come exclusively from operator configuration; candidate repository content
cannot choose them. HTTPS is required except for loopback test receivers.
Redirects are never followed. Keep the operator listener private or use an
operator-controlled authenticated HTTPS gateway; it carries Basic credentials.

Each subscriber has an independent durable outbox, bounded request timeout and
retry budget. Defaults are eight attempts, a five-second timeout and a
one-second retry delay. Delivery accepts ordinary HTTP 2xx responses; receivers
do not implement the CI receipt protocol. Delivery is at least once: receiver
code must deduplicate by event ID.

Messages use the JSON event format from [CloudEvents 1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
and raw-body signing from [Standard Webhooks 1.0.0](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
`webhook-id` is stable for the immutable producer event. The source UUID is
owned by the outbox database and survives restarts and backups, so independent
installations do not collide. Each attempt also has a fresh
`X-Dim-Webhook-Attempt-Id`. Never normalize or reserialize the request body
before signature verification.

The independent operator listener exposes:

- `GET /v1/webhook-operator-identity`.
- `GET /v1/projects/PROJECT/webhook-deliveries`.
- `POST /v1/projects/PROJECT/webhook-deliveries/SUBSCRIBER/EVENT/retry`, with
  JSON `{"requestId":"UUID"}`.

These requests use their own Basic credentials and current
`X-Dim-Generation-Id`. Project scope is checked before access. Retry is allowed
only after a delivery has failed or exhausted its budget, never while its
lease is active. The durable request UUID makes an operator retry idempotent.
Mutation requires JSON and rejects foreign browser origins. Changing a
subscriber's endpoint or key requires a new subscriber ID, preventing old
outbox entries from being silently redirected.

Back up the entire private state directory while the service is stopped.
Producer history must remain available for backfill. Git producers publish
authoritative review and finalized-ref metadata, not every Git transport packet.
Network delivery never holds the repository authority serialization gate.
