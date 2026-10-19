# Ordinary remote development

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
