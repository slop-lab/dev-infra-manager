# Host Node review detector handler

`@slop-lab/dim-host-plugin-review-tracing-node` contributes the `review-tracing`
task handler to the execution worker. Install it alongside the worker plugin on
the chosen host. This plugin has no separate command, queue or polling loop.
The existing worker discovers its handler through installed host extensions.

Configure a slot on both the scheduler and worker with matching `taskType` and
`handlerRevision`. The revision identifies the installed Node implementation
and its pinned Docker image. Obtain the digest from the installed runtime:

```sh
node --input-type=module -e 'import {reviewTracingTaskHandler} from "@slop-lab/dim-host-plugin-review-tracing-node"; console.log(reviewTracingTaskHandler.revision)'
```

```json
{ "id": "review", "taskType": "review-tracing", "handlerRevision": "<64 lowercase hex characters>" }
```

Task-only workers need no Native Git endpoint, Git credentials, Sysbox runtime
or KVM device. They need Docker access and the exact image documented in the
[shared Node runtime](../../../review-tracing-node/README.md). Repository source
arrives through lease-authorized file read exchanges; it is never mounted or
cloned on the worker. The control plane records dependency digests and retains
review and promotion authority.

Each execution names and labels its disposable container with its journaled
execution UUID. The common worker aborts on lease loss and refuses slot reuse
until exact owned resource cleanup succeeds. On restart it cleans the recorded
execution rather than resuming project code. The execution host is trusted to
run the configured handler faithfully and can read source provided to it.
