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

For an unpublished source checkout, build the local bundle and install its
matching core before adding the plugin from that same bundle:

```sh
just prepare-local
just install-local
bundle="$PWD/.local/dim-packages"
version="$(bash scripts/local-package-version.bash "$bundle")"
dim installer install plugin --local-packages "$bundle" \
  "@slop-lab/dim-host-plugin-kvm@$version"
```

Then run `dim kvm configure`, `dim kvm doctor` and the workspace creation command
above on that host.

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

The preflight reports selected caches or explicitly says `direct`. If the host's
mirrors plugin configured this workspace, the gate automatically passes its
public APT/npm/Docker cache URLs into both fresh VMs. The gate does not start
cache servers. On the selected host, configure the
[mirrors client](../packages/host/plugins/mirrors/README.md) and, when needed,
the separate [cache server](../packages/host/plugins/cache-server/README.md).
An operator can instead select an existing URL catalog explicitly:

```sh
DIM_EXAMPLES_CACHE_CATALOG=/absolute/package-caches.json bash scripts/dev.bash verify-vm
```

Node, pnpm, Just and Sysbox are pinned binary downloads rather than npm packages.
The gate downloads each once into its outer SHA256 artifact cache, checks the
digest, and seeds both VMs; each installer copies and checks the bytes again.
Ubuntu images use the same persistent artifact cache. It lives in
`$XDG_CACHE_HOME/dim/artifacts` or `~/.cache/dim/artifacts`; `DIM_ARTIFACT_CACHE`
selects another absolute directory. Keep this workspace to reuse its cache on
later runs. The default workspace does not mount the physical host's cache.
Source compilation and image building still take time. APT's HTTPS downloads
remain direct; an npm cache does not cache GitHub or Node.js binary downloads.

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
