# Shared LLM service attachment acceptance

The preserved issue attachment specifies logical responsibilities rather than
mandatory transports. This plugin implements one HTTP binding and a small
operator CLI; it does not own application agents, conversations, Langfuse or
provider refresh. The backend is a separately operated pinned CLIProxyAPI
partition. No live provider account or OAuth secret was accessed by these tests.

| Criterion | Implemented proof / explicit boundary |
| --- | --- |
| A01 | Host-owned ledger/archive and persistent principals are independent of guest lifecycle. Core UUID fencing and actual guest lifecycle checks cover recreation; HTTP and restore tests preserve access and state. |
| A02 | Multiple principals share a stable project; rotation does not reset quotas/history. Atomic HTTP test exercises the last admission across two principals. |
| A03 | Authenticated project ownership is mandatory; claimed project headers/body and foreign capture IDs are rejected. Provider continuation is unavailable, not accepted without authorization. |
| A04 | Concurrent deterministic backends receive only their account partition's key, and an expired account does not disable another. Actual provider identity selection requires operator verification of each exclusive backend partition; aliases are not an account boundary. |
| A05 | CLIProxyAPI remains the only OAuth/refresh owner. Health distinguishes backend authentication from unknown provider health. Fake expired-account isolation is tested; live refresh during concurrent provider work remains an authenticated-backend deployment check. |
| A06 | SQLite immediate transactions atomically reserve service/project requests, concurrency, required capture and estimated token allowance. Competing admissions cannot both consume the final reservation. |
| A07 | Strict token policies and unsupported backend capability profiles are rejected explicitly. No tokenizer/timeout is advertised as a hard token cap. |
| A08 | Execution/delivery/accounting/capture states differ. Unknown usage and ambiguous cancellation preserve reservations and occupancy; operator resolution is audited. |
| A09 | One wrapper dispatch has one stable attempt ID; duplicate completion settlement does not charge twice. Hidden retries and destructive backend telemetry queues are not integrated or represented as exact attempt accounting. |
| A10 | Numeric totals preserve raw details without adding overlapping cache/reasoning fields. Invalid or unknown usage remains unnormalized. |
| A11 | HTTP/SSE tool and inline/referenced multimodal/unknown supported fields retain exact bytes. Unsupported stateful/account selection is rejected. Referenced objects are not fetched. |
| A12 | Token-like strings, executable-looking text and repeated context round-trip through private originals/export without masking or semantic deduplication. |
| A13 | Manifests name client application-body capture and exclude auth headers, translated upstream bodies and remote referenced bytes. |
| A14 | Required, best-effort and metadata policies are tested before dispatch and during stream capacity exhaustion. Incomplete storage never receives a complete manifest. |
| A15 | Real router subprocess SIGKILL/restart test retains unknown dispatch occupancy and estimated reservations without replay. Administrative readers do not recover a live service. |
| A16 | Request-level usage and hidden-attempt gaps are explicit in capabilities, manifests and usage. No lossy usage queue is polled as an authoritative journal. |
| A17 | Project policy edits/pause affect new admissions; an active snapshot remains stable. Explicit disable/revoke/cancel requests best-effort cancellation. |
| A18 | Requests require neither tracing SDK, Langfuse, session ID nor correlation metadata. |
| A19 | Downloads are inert octet-stream attachments; export contains data only. No payload rendering runs commands or inference. |
| A20 | Consistent stopped-service snapshot includes ledger, captures, configured local credential state, hashes and unresolved reservations; restore does not replay. A remote backend needs its own backup. Additional future bindings must reuse these contracts; none are claimed tested before implementation. |

The wrapper does not perform automatic transport retries, change global backend
configuration around requests, switch billing mode or silently substitute an
observed model. Unexpected observed model identity fails visibly while its
captured output/usage remains recorded. Account health does not make hidden
billable inference. Raw observations, operator corrections and unknowns remain
distinct. Calendar budgets use UTC and admission booking; physical uncertainty
can survive any period boundary.
