# Ordinary remote development

## Runnable recipe

[`recipe.json`](recipe.json) owns the exact host/control-plane plugin selection,
repository paths and executable stages. From the DIM repository root:

```bash
node scripts/examples/run.ts examples/projects/basic-development install-host
node scripts/examples/run.ts examples/projects/basic-development install-control-plane
node scripts/examples/run.ts examples/projects/basic-development verify
```

`verify` is a fast local check using the locked source toolchain; it does not
install plugins or authenticate provider accounts. `dev` runs this directory's
actual setup/service script after the prerequisites below are configured.
For workspace recipes, set `DIM_EXAMPLE_WORK` to a fresh absolute operator
directory; source templates are copied and committed there, never overwritten.

`verify-vm` uses the installed DIM command to create a workspace, run its checked-in
verification script, and discard the workspace on success or failure. It requires
a prepared base image; native recipes also require a live, saved control-plane
connection. It exercises workspace integration, not execution of CI jobs in a
QEMU worker. The separate CI runner gates cover that backend.
See the [recipe runner](../../README.md) for shared options and the heavy VM gate.

The same commands work on the local host and a selected SSH development host.
The source repository needs no DIM manifest or lifecycle hook.

Required components: base DIM on the selected host, Docker with the Sysbox
runtime, and a workspace image built below. No optional host plugin, managed
administration, native Git service or CI worker is required. Remote use also
requires operator SSH access to that host.

```bash
dim host add development --ssh user@development-host
dim host use development
dim image build
dim create https://example.com/team/app.git app
dim exec app -- sh
```

Inside the workspace, install dependencies and run the repository's ordinary
development commands. Its nested Docker daemon is private to the workspace.
For example, start a server listening on workspace loopback port 3000, then
connect from another client terminal:

```bash
dim forward app 3000:3000
```

Home, checkout and nested Docker data survive `dim stop app`, `dim start app`
and `dim recreate app`. `dim discard app --yes` deletes the workspace and its
owned persistent data. Source paths, when used instead of Git URLs, refer to
the selected host. Operator secrets and host Docker sockets do not belong in
the development container.

For DIM itself, explicit repository tasks are documented in
[.dim/README.md](../../../.dim/README.md). Native proposal Git, human review and
optional shared CI are a separate example in
[native-basic-root](../native-basic-root/README.md).
