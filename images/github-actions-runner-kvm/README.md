# Ephemeral QEMU GitHub Actions Runner

This machine image runs one GitHub Actions job in a disposable Ubuntu QEMU
guest. The guest has Docker, Sysbox, QEMU, and nested KVM, so it can match both
the `sysbox` and `kvm` self-hosted workflow labels.

The QEMU host must expose writable `/dev/kvm`, enable nested virtualization in
its KVM module, and have enough memory for a guest that may itself start QEMU.
The defaults allocate 6 vCPUs, 12 GiB RAM, and a 48 GiB overlay.

Build the reviewed base image:

```bash
just build-github-runner-kvm
just verify-github-runner-kvm
```

The build pins the Actions runner version and SHA-256 in `build.sh`. Override
both together when deliberately updating it:

```bash
ACTIONS_RUNNER_VERSION=VERSION \
ACTIONS_RUNNER_SHA256=SHA256 \
just build-github-runner-kvm
```

Start an ephemeral runner:

```bash
GITHUB_RUNNER_URL=https://github.com/slop-lab/dev-infra-manager \
just run-github-runner-kvm
```

By default, an authenticated `gh` CLI requests the one-hour repository runner
registration token. Alternatively, pass it only in the process environment as
`GITHUB_RUNNER_TOKEN`. The token is sent after boot over SSH; it is not stored
in the base image or cloud-init seed.

The runner registers with `--ephemeral`, accepts one job, powers off, and
deletes its overlay and SSH key. Do not put long-lived npm, GitHub, project, or
secret-environment credentials in the base image.

GitHub only allows `workflow_dispatch` for workflow files present on the
repository's default branch. Promote a new self-hosted workflow definition to
`main` before trying to dispatch it against `development`.
