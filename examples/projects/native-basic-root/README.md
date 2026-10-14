# Native basic root

This directory is the smallest reviewed root for native lifecycle and both
candidate-controlled execution kinds. Copy it into a new Git repository,
commit it on `main`, then use distinct caller-owned role files:

```bash
dim project bootstrap-native-root native-basic \
  --project-id native-basic-root \
  --source-repository "$PWD" \
  --source-ref refs/heads/main \
  --registrar-connection /absolute/operator/registrar.json \
  --importer-connection /absolute/operator/importer.json \
  --json

export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/control-plane.json
export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/absolute/operator/importer.json
dim project create native-basic --json
dim project list --json
dim project show native-basic --json
dim workspace create native-basic native-basic-work
dim workspace show native-basic-work --json
```

The role files are generated from the installed service configuration by the
operator. They are mode `0600`, remain outside the repository and workspace,
and use distinct registrar, importer, root-read, workspace-write, reviewer,
promoter, ordinary host, and QEMU host credentials.

Project and workspace readiness complete before either CI host runs. A proposal
push queues both declared jobs. Their result class is
`candidate-controlled`: success says these exact scripts exited zero under the
recorded operator images and bounds. It is not human approval, independent
verification, or authority to promote.
