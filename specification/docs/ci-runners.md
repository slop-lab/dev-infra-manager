# Global native CI

Ordinary and QEMU execution are global host services:

```bash
dim ci native-root host run /absolute/operator/ordinary-host.json
dim ci native-qemu scheduler image build registry.example/dim-native-qemu-scheduler:0.10.0
dim ci native-qemu runner image build registry.example/dim-native-qemu-runner:0.10.0
dim ci native-qemu scheduler run /absolute/operator/qemu-scheduler.json
dim ci native-qemu host run qemu-a /absolute/operator/qemu-host.json
```

There is no Project-scoped runner lifecycle or manual Project admission.
Trusted native registration supplies eligibility. A proposal push creates work
for every valid candidate-declared job; protected policy selects only which
current successful results are required for promotion.

Ordinary jobs run in bounded Sysbox containers. QEMU jobs run in bounded real
KVM guests. Candidate content supplies the script, not images, resource bounds,
host commands, mounts, networks, URLs, or credentials. Both evidence kinds are
candidate-controlled and cannot approve or promote.

The ordinary host command loads the enabled exact-version host mirror plugin
and reconciles DIM-owned Docker Hub cache and control-network resources before
locking or advertising capacity. It fails closed when that provider is absent
or the resources conflict with DIM ownership.
