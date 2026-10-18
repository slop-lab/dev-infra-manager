# Examples

- [Ordinary remote development](projects/basic-development/README.md) uses the
  base Git workspace, explicit development commands and local forwarding.
- [Native Project](projects/native-basic-root/README.md) adds proposal Git,
  human review and candidate-controlled ordinary or QEMU jobs.
- [Codex](use-cases/codex/README.md) installs the reviewed coding tool explicitly
  into a workspace's persistent home.
- Optional feature examples live under `features/` with their owning
  integration. They do not change the base workspace lifecycle.

The native Project fixture has source checks in
`verification/test/nativeBasicExample.test.mjs`. Real Git, runtime, service and
CI verification require their declared disposable host prerequisites; source
structure checks alone do not establish runtime or multi-host acceptance.
