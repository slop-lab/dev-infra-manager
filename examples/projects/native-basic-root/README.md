# Native basic root

This directory is the smallest reviewed root for native lifecycle and both
candidate-controlled execution kinds. Copy it into a new Git repository,
commit it on `main`, then use distinct caller-owned role files:

```bash
dim managed project bootstrap-native-root native-basic \
  --project-id native-basic-root \
  --source-repository "$PWD" \
  --source-ref refs/heads/main \
  --registrar-connection /absolute/operator/connections/registrar.json \
  --importer-connection /absolute/operator/connections/importer.json \
  --json

export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/connections/host.json
export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/absolute/operator/connections/importer.json
dim managed project create native-basic --json
dim managed project list --json
dim managed project show native-basic --json
dim create dim://native-basic native-basic-work
dim show native-basic-work --json
```

Generate initial host and bootstrap role files with
`dim managed control-plane prepare` and `dim managed control-plane connect`.
Configure the real CI host capacities required by this example separately. They are mode `0600`, remain outside the repository and workspace,
and use distinct registrar, importer, root-read, workspace-write, reviewer,
promoter, ordinary host, and QEMU host credentials.

Project and workspace readiness complete before either CI host runs. A proposal
push queues both declared jobs. Their result class is
`candidate-controlled`: success says these exact scripts exited zero under the
recorded operator images and bounds. It is not human approval, independent
verification, or authority to promote.
