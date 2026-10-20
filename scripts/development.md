# Explicit repository development tasks

This repository uses an ordinary DIM workspace. Its own task script manages
repository dependencies and checks; generic coding-agent installation belongs
to the optional tools plugin.

```sh
dim create /path/on/selected/host/to/dev-infra-manager dev
dim exec dev -- bash scripts/dev.bash setup
dim exec dev -- bash scripts/dev.bash check
dim installer install plugin '@slop-lab/dim-host-plugin-agent-tools@0.10.0'
dim tools setup dev codex
dim tools run dev codex --resume-on-restart
```

`dim run dev codex` and `dim run dev opencode` execute the installed tool
normally. The `dim-agent` adapter adds explicit session continuation support;
`dim tools run dev TOOL` invokes it on the selected local or SSH host. No
repository-specific agent bootstrap or runtime hooks are required.

## KVM example verification inside a workspace

`bash scripts/dev.bash help` lists the repository tasks. From inside a workspace,
start with `bash scripts/dev.bash verify-vm --preflight-only` (also available as
`just verify examples-vm-preflight`). It checks the current environment, creates
and closes an empty VM with the KVM API, and prints missing tools and the next
command. `dim doctor` checks the selected DIM host's base prerequisites; it does
not establish that a workspace can open KVM.

The ordinary `container` runtime has no host devices. On the selected DIM host,
install and configure the optional KVM runtime, then create a dedicated workspace:

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-kvm@0.10.0'
dim kvm configure
dim kvm doctor
dim create /path/on/selected/host/to/dev-infra-manager dim-verify \
  --runtime container-kvm --cpus 4 --memory 12g --pids 8192
dim shell dim-verify
```

Inside the new workspace, install the VM tooling and check readiness:

```sh
bash scripts/dev.bash setup-vm
bash scripts/dev.bash verify-vm --preflight-only
bash scripts/dev.bash verify-vm
```

`setup-vm` uses `sudo apk add` on the default Alpine workspace image and
`sudo apt-get` on Ubuntu/Debian; it installs QEMU, cloud-localds and their tools,
then runs the preflight. Use Node.js 24 or 26 and Just from the workspace image. The final command requires
a clean committed checkout and at least 24 GiB of free temporary storage. It
boots two simultaneous, independent Ubuntu KVM VMs: one runs the installed
control plane and its plugins; the other runs the installed host, its plugins
and workspace examples. They communicate across the VM boundary. Each VM has a
separate disk and DIM state; the outer workspace needs no host Docker socket or
host operator credentials. Evidence is written to `.local/checks/examples-vm-*`.

KVM access is an explicit operator grant and exposes the host kernel's KVM
interface. Repository configuration cannot grant it. Configure only on a host
where this is appropriate; ordinary development does not require the plugin.
See the [verification profile](../docs/development/verification.md) for candidate
identity, resource cleanup and CI scheduling.

For OpenCode's browser UI, set up `opencode`, then run `dim tools server dev`.
It starts only an authenticated loopback backend. The static
[Pages UI](../tools/opencode-web/README.md) connects to its approved HTTPS URL;
its workspace-owned temporary volume stays outside `/tmp` and authentication
configuration. For local access use a separately configured local client
origin rather than weakening the default Pages CORS policy.
