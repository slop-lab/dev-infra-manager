# CLI contract

The default development flow is:

```sh
dim doctor
dim image build
dim create /path/on/host/repository dev
dim ls
dim exec dev -- git status
dim shell dev
dim stop dev
dim start dev
dim recreate dev
dim discard dev --yes
```

Workspace operations are available directly and under `dim workspace` through
one command registration. `list` accepts `ls`. These are deliberate ergonomic
entry points. `create SOURCE NAME` accepts an ordinary Git URL or host-local
path, with optional ref, image, Git author and resource flags. `show` and `list`
report persisted phase separately from the observed runtime status. A stopped
or missing runtime is not silently represented as a ready process.

```sh
dim host add devbox --ssh user@host
dim host use devbox
dim --host devbox ls
dim host list
dim host remove devbox
```

The selected context determines the machine that owns source paths, workspace
state, images and Docker resources. `exec` preserves stdin, output and command
exit status. `shell` requests an interactive terminal. Machine-readable record
commands support `--json`; progress and diagnostics must not corrupt stdout.
User/input errors exit 2 and unexpected failures exit 1.

Managed administration is loaded only when selected and requires the optional
`@slop-lab/dim-managed` package. Missing installation produces actionable setup
guidance. The base help and workspace lifecycle work without that package or
its service dependencies. Managed-specific commands are documented by their
[owning package](../../core/packages/managed/docs/cli.md).
