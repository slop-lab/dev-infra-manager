# CLI Contract

**Kind: Contract**

User and input errors exit `2`; unexpected failures exit `1`. Commands that
produce records support `--json` and never expose credentials, connection-file
contents, authorization headers, tokens, or credential-bearing URLs.

## Public surface

The native-only public lifecycle is:

```text
dim project bootstrap-native-root PROJECT --project-id ID \
  --source-repository ABSOLUTE_PATH --source-ref refs/heads/BRANCH \
  --registrar-connection ABSOLUTE_FILE --importer-connection ABSOLUTE_FILE \
  [--review-policy ABSOLUTE_FILE] [--git-executable ABSOLUTE_PATH] [--json]
dim project create PROJECT [--json]
dim project list [--json]
dim project show PROJECT [--json]

dim create PROJECT WORKSPACE
dim list|ls [--json]
dim show WORKSPACE [--json]
dim resources WORKSPACE --cpus COUNT|--memory SIZE|--pids COUNT [--json]
dim setup|start|stop|restart|update WORKSPACE
dim run WORKSPACE shell
dim run WORKSPACE exec|custom -- COMMAND...
dim exec WORKSPACE -- COMMAND...
dim discard WORKSPACE --yes

dim host status [--json]
dim host shutdown|start
dim doctor
dim workspace image build|status

dim ci native-root host run ABSOLUTE_FILE
dim ci native-qemu scheduler run ABSOLUTE_FILE
dim ci native-qemu scheduler image build IMAGE
dim ci native-qemu runner image build IMAGE
dim ci native-qemu host run HOST_ID ABSOLUTE_FILE
dim ci native-qemu event status EVENT_ID ABSOLUTE_FILE
```

Common workspace commands are registered both directly under `dim` and in
the `dim workspace` group, with identical arguments and behavior. `list` also
accepts `ls`. Local image operations remain under `dim workspace image`.

There are no repository CRUD/synchronization commands, Project remove/purge
commands, Project-scoped runner commands, ordinary-pool commands, or manual
native CI admission/refresh commands. Obsolete tokens are rejected rather than
aliased.

## Project bootstrap and readiness

**CLI-NATIVE-ROOT-001:** Bootstrap accepts only an already-local reviewed Git
repository and one canonical full branch ref. It stages one immutable native
root and policy through distinct registrar/importer roles. It creates no
runnable Project, workspace, CI job, review, approval, or promotion.

**CLI-NATIVE-PROJECT-001:** Plain `project create` consumes the exact imported
root, obtains fresh proof, publishes pending state, revalidates live native
readiness and the protected-root snapshot, then atomically publishes schema-6
`ready`. Exact replay converges. Readiness neither starts nor waits for CI and
creates no approval. `list` and `show` expose bounded identity, ref, commit,
tree, policy, phase, and readiness fields only.

## Workspace and Git authority

**CLI-NATIVE-WORKSPACE-001:** Workspace creation requires a ready native
Project and publishes strict schema-9 native source state. Setup may replay the
recorded immutable snapshot without requiring fresh native proof; start,
restart, and update require fresh native proof. None may reinterpret provider
state. Brokered Git
allows only create or fast-forward in the exact workspace proposal namespace.
Protected, delete, force, tag, foreign-workspace, and foreign-Project requests
fail before ref mutation.

## Global host services

**CLI-NATIVE-HOST-001:** Long-running ordinary and QEMU commands consume only
their fixed private config. They accept no Project credential, candidate image,
resource override, mount, network, command, or fallback executor in argv.
Signal handling drains owned work and returns `125` when cleanup ownership is
uncertain. Missing Sysbox or KVM is unavailable before a claim is requested.
