# Optional persistent VM integration

`@slop-lab/dim-plugin-vm` provides an Incus/KVM `vm` workspace runtime and
independent persistent VMs with scoped browser SPICE consoles. Install it as
an explicit host plugin; the base container workspace does not need Incus,
KVM, this package, its WebSocket dependency or graphical console assets.

The trusted host needs Incus, its guest-agent-capable reviewed VM image, an
existing private Incus project, a storage pool, a managed IPv4 bridge and a
writable cgroup-v2 delegation with CPU, memory and PID controllers enabled. The
VM guest image must provide UID/GID 1000 `dim`, `/home/dim`, Git, Node.js and
Docker, util-linux `runuser` and a boot service for Docker. Saved agent sessions
resume through guest systemd; workspace SSH additionally needs OpenSSH and
passwordless sudo inside the guest. Install Docker **inside the guest**. Do not expose the Incus socket,
host Docker socket, host filesystem or host operator credentials to it.
No host KVM device is injected. Nested virtualization is not required by the
workspace; VM tests can use a separately granted persistent auxiliary VM.

## Host configuration

Review a host configuration file and save it once with
`dim vm configure /absolute/path/to/vm-host.json`. Paths resolve on the host
selected by `dim --host`. Configuration is private host state under
`$DIM_STATE_ROOT/plugins/vm/config.json`.

```json
{
  "schemaVersion": 1,
  "project": "dim",
  "storagePool": "vm-storage",
  "network": "vmbr0",
  "guest": { "cpuCount": 4, "memory": "8GiB", "disk": "40GiB" },
  "cgroupRoot": "/sys/fs/cgroup/dim-vm",
  "budgetHelper": "/usr/local/bin/dim-vm-budget",
  "incusSocket": "/var/lib/incus/unix.socket",
  "spiceAssets": "/usr/share/spice-html5/src",
  "console": { "address": "127.0.0.1", "port": 8089 }
}
```

The normal host CLI does not need to run as root. Install the matching plugin's
root budget helper once on that selected host, using a reviewed root-owned
Node.js 24 or 26 executable and a root configuration such as:

```json
{
  "schemaVersion": 1,
  "project": "dim",
  "incusSocket": "/var/lib/incus/unix.socket",
  "cgroupRoot": "/sys/fs/cgroup/dim-vm",
  "qemuExecutable": "/usr/bin/qemu-system-x86_64"
}
```

From this source checkout, after building the reviewed plugin artifact:

```bash
sudo bash plugin-vm/scripts/install-budget-helper.bash \
  /usr/local/lib/dim-tools/node /path/to/reviewed-root-budget.json YOUR_HOST_USER
# Review the installed PATH drop-in, then explicitly activate it:
sudo systemctl daemon-reload
sudo systemctl restart incus
```

The same setup script ships with the published plugin through its
`@slop-lab/dim-plugin-vm/budget-setup` export. Setup is explicit and never runs
as a package installation script. It installs immutable root-owned helper
code, a narrowly matched sudoers rule and an Incus service PATH drop-in. It
does **not** restart an existing daemon automatically. Coordinate that
operator restart with other Incus workloads.

The helper independently checks Incus instance ownership, pinned image,
QEMU identity and PID. It accepts no caller-selected host paths, executable,
project or process outside that owned VM. Its standalone privileged modules
have no dependency on user-writable core/npm packages. Environment is reset
before Node runs. A shared kernel flock serializes root budget intent changes
and QEMU admission for the same UUID.

The root-owned PATH wrapper joins QEMU to its UUID cgroup **before exec and
fork**, preserving Incus' device descriptors. Thus guest-initiated reboot also
inherits host limits and OOM preference 500. Unrelated Incus instances pass
through to the original binary. The cgroup path is an explicit root-configured
fence; its parent must provide the CPU, memory and PID controllers. A missing
or inaccessible helper/delegation fails closed. Guests never receive access
to it. The project, storage pool and network are host-managed; DIM does not
silently initialize or change an existing Incus installation.

Use an exact local Incus image fingerprint, after importing and reviewing the
image through your host's image acquisition process:

```bash
dim create /host/path/to/repo dev --runtime vm --image FULL_64_CHARACTER_IMAGE_FINGERPRINT
dim exec dev -- docker info
dim stop dev
dim start dev
dim recreate dev
dim resources dev --cpus 1.5 --memory 10g --pids 2048
# Guest allocation is independent and requires a stopped VM:
dim stop dev
dim vm allocation workspace dev --cpus 4 --memory 8GiB
dim start dev
```

The ordinary lifecycle, Git source acquisition, remote host selection and
streaming exec/forward commands remain shared with container workspaces.
Recreate stops and restarts the QEMU machine with its existing root disk.
The root disk includes home, checkout, guest Docker data and the dim-owned private
0700 `/mnt/dim-tmp` directory used by workspace tools. Missing storage
for an initialized workspace is an error; it never becomes a fresh empty VM.
Only explicit discard destroys that disk. Incus autostart is disabled; start
through DIM after a host reboot to reapply host ceilings before running tools.

Guest `cpuCount` and `memory` allocation (always finite) are separate from DIM host resource
ceilings. Host CPU quota, memory maximum and task maximum are applied to the
plugin-owned QEMU cgroup, including `unlimited` for each independent ceiling. The
plugin does not misuse Incus' container-only `limits.cpu.allowance` or
`limits.processes` options. Ordinary demand-paged guest memory is used, huge
pages are disabled, and the virtio balloon enables free-page reporting.
Guest kernel support and measurable host memory return must be verified on
the actual image and Incus/QEMU version; configuration alone is not proof.
CPU ceilings below 0.01 are rejected by the VM cgroup adapter. A host PID
limit counts QEMU host tasks, not guest processes.

## Persistent auxiliary VMs and browser console

```bash
dim vm create desktop FULL_64_CHARACTER_IMAGE_FINGERPRINT
dim vm start desktop
dim vm ls
dim vm resources desktop --cpus unlimited --memory 10g --pids 2048
dim vm grant desktop dev
dim vm console 8089
dim vm revoke desktop CORE_WORKSPACE_UUID
dim vm stop desktop
dim vm discard desktop
```

Auxiliary VMs have separate records and disks and survive workspace discard.
Access grants bind a core workspace UUID and current initialized/running
state, so name reuse cannot inherit access. Grant issues a private scoped
credential at `~/.config/dim/vms/desktop.json` **inside that workspace**. The
host stores only its hash. Grant rotation/revoke affects that workspace only.
An existing browser stream is closed when its grant or workspace becomes
invalid. The credential allows the named VM's console, not the Incus API or
host management. Stop/revoke a grant before handing a workspace to another
operator.

The console defaults to trusted-host loopback. To make scoped console access
reachable from a workspace, explicitly configure its private Incus bridge
gateway as `console.address`; wildcard and public addresses are rejected.
The delivered credential file includes that console URL. Treat HTTP on a
private bridge as private-network traffic; use an authenticated TLS ingress
when traffic crosses an untrusted network. For a remote host, use an SSH
local port forward, then open `http://127.0.0.1:8089`. Enter the VM name and
its scoped token, or the private host owner token file printed by the command.
The browser receives only a scoped SPICE stream; Incus operation secrets stay
on the host. The console requires reviewed `spice-html5` ES module assets
installed separately on that host. No third-party script is loaded from a CDN.
Only HTTP-only, same-site sessions are used; browser upgrade checks its origin.

## Verification

Unit tests cover ownership collision, missing initialized storage, retention,
command/stream boundaries, separate resource limits and grant revocation on
workspace stop/discard/name reuse. Real Incus/KVM acceptance additionally
requires guest-agent startup, nested guest Docker, reboot/recreate retention,
host quota enforcement, measured demand-paging/free-page return, and a real
browser SPICE handshake. A fake command runner does not establish these
hardware/runtime properties. See the recorded physical test evidence before
calling a host/image supported.

Backend facts: [Incus VM creation](https://linuxcontainers.org/incus/docs/main/howto/instances_create/),
[resource options](https://linuxcontainers.org/incus/docs/main/reference/instance_options/),
[console transport](https://linuxcontainers.org/incus/docs/main/api-extensions/#console-vga-type).
