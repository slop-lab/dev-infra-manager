# CLI contract

The default development flow is:

```sh
dim doctor
dim image build
dim create /path/on/host/repository dev
dim ls
dim exec dev -- git status
dim shell dev
dim connect dev 3000
dim forward dev 3000:3000
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

`connect WORKSPACE PORT` carries raw stdin/stdout to `127.0.0.1:PORT` inside
the workspace, without a terminal. Diagnostics use stderr. `forward WORKSPACE
LOCAL:REMOTE` listens only on the client's `127.0.0.1`, forwarding each accepted
connection through the selected host. Local port zero selects an available
port; remote ports are integers from 1 to 65535. Forwarding pins workspace
identity once and rejects a replacement that reuses its name. Closing clients
or cancelling forwarding closes owned streams and host processes. Neither
command publishes a Docker port or requires a managed service.

Optional feature commands are owned by explicitly installed host plugins.
Native Git owns `dim project` and `dim://` source acquisition; the worker plugin
owns `dim execution worker`. Control-plane operator tools own `dim control-plane`.
Missing optional components produce actionable installation guidance. Base
workspace commands and the generic controller use host core only. See the
[Native Git guide](../../packages/host/plugins/native-git/docs/cli.md).

Managed workspace creation accepts repeated `--repository ID` and `--workdir ID`
with a `dim://PROJECT` source. Selection defaults to the Project's default working
repository; an explicit selection must include the working repository. Ordinary
Git sources reject these managed selection options. The code-review package owns
`dim-code-review resolve|inspect|approve|revoke`; merge-policy owns
`dim-merge-policy promote`. Their generated private reviewer/promoter connections
and commands select both Project and repository. Repository hosting alone
installs neither operator CLI.
