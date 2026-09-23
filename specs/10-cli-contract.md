# CLI Contract

**Kind: Contract**

The `@slop-lab/dim-cli` package is the local approval and execution client. It
does not contain or depend on a Git provider, CI manager, remote scheduler, or
host-admin controller.

## Commands

```text
dim approve --config LOCAL_CONFIG REVIEWED_APPROVAL
dim run-remote --config LOCAL_CONFIG --request-id REQUEST_ID PROJECT_ID
```

`approve` parses schema-1 configuration and approval files strictly, then
atomically records the operator's approval under `approvalRoot`. Unknown fields,
old schemas, malformed digests, relative state paths, and unsafe path patterns
are rejected. Incompatible state is never migrated implicitly; the error tells
the operator to export needed data and recreate it.

`run-remote` sends one schema-1 poll request to the configured SSH broker. It
admits the returned proposal locally and invokes only a workload ID present in
the local configuration. Remote data cannot select a command, executable,
argument, environment variable, mount, device, image, URL, socket, or runtime.

User input and policy failures exit `2`; unexpected failures exit `1`; the
approved local workload's exit code is returned unchanged. `--help` and
`--version` exit `0`.

The removed project, repository, managed-controller, workspace-host, and CI
commands belong to the separately installed control plane. They are not
accepted as compatibility aliases.
