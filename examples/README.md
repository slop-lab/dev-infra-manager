# Examples

DIM ships one current adoption example:

- [`projects/native-basic-root`](projects/native-basic-root/README.md) is a
  reviewed single-root native Project with candidate-controlled ordinary and
  QEMU jobs. It uses no forge service, provider webhook, repository CRUD, or
  Project-scoped runner.

Other directories are retained only as predecessor source material for
operator export and historical comparison. They are not runnable by the
native-only verification recipes and do not define supported commands.

The current fixture is checked structurally with:

```bash
pnpm --dir verification exec vitest run test/nativeBasicExample.test.mjs
```

End-to-end mechanics run only on a disposable host with installed native
services, `sysbox-runc`, and real KVM. See
[`verification/scripts/kvm-guest-verification-smoke.bash`](../verification/scripts/kvm-guest-verification-smoke.bash).
