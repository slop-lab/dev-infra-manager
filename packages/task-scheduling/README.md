# Task scheduling

`@slop-lab/dim-task-scheduling` owns the durable execution queue used by CI and
other explicitly installed task handlers. It has no Git, workflow, review, host
runtime or control-plane dependency.

`TaskStore` provides idempotent enqueue and reservation, generation fencing,
lease renewal, cancellation, retries, owned recovery and result publication.
Its domain codecs validate events, grants and results, and the complete stored
aggregate after every transition. The CI adapter supplies its existing native
Git authorization rules alongside generic task schemas. Both use the same
database and unique occupied-slot index, so tasks cannot bypass CI capacity or
recovery requirements.

Generic tasks identify their type and exact handler revision. Their grants bind
the event and selected worker profile through a canonical descriptor digest;
the worker, slot, generation and lease remain explicit scheduler ownership.
Task payloads and result values are bounded JSON, and result publication requires
confirmed resource cleanup. A handler mismatch leaves the task queued for
compatible capacity. An expired or cancelled execution keeps its slot fenced
until the owning worker confirms cleanup.

The scheduler does not interpret payloads or decide what a successful task
means. Trusted plugins own those checks and any scoped interactive broker
operations. Worker callbacks expose only those handler operations, never an
arbitrary remote command or host filesystem API.
