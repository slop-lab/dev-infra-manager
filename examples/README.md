# Examples

## Project examples

Project examples are complete, copyable adoption shapes:

- [`projects/single-repository/`](projects/single-repository/README.md) is the
  default: one repository, no secrets or protected ref, resource limits, and
  a Project-owned agent/private DinD pair, and an optional external URL.
- [`projects/multi-repository/`](projects/multi-repository/README.md) adds
  independent repository and secret-bearing review boundaries.

## Feature examples

Feature examples isolate one capability in the smallest useful Project or
support process:

- [Managed CI runner](features/ci-runner/README.md)
- [External URLs](features/external-urls/README.md)
- [External URL route policy](features/external-url-route-policy/README.md)
- [Several managed repositories in one upstream](features/shared-upstream/README.md)

## Verification

Every runnable example stores logical repository fixtures under
`repos/<alias>`. Its materializer creates the required disposable external Git
layout—normally one remote per alias, or a namespaced shared remote when that
layout is the feature being demonstrated—and registers the complete set in a
temporary managed Gitea.

Run an example against the currently installed host runtimes:

```bash
just verify example current-installed auto
```

Or install a backend in a clean Ubuntu QEMU guest and run the same verification
there:

```bash
just verify example runc use
just verify example sysbox use ci-runner
just verify example gvisor use external-urls
```

The QEMU harness gives every selected example its own disposable overlay and
guest; even a full suite does not reuse a VM between examples. It provisions
the guest OS, selected runtime backend, Node.js, pnpm, and `just`. After
provisioning, it enters repository-owned behavior only through `just install`
and `just verify example`; it does not maintain a second example command
sequence in the VM wrapper.

The second argument controls a dirty source checkout:

- `auto` rejects it, which is the default.
- `use` snapshots tracked changes and non-ignored untracked files.
- `discard` verifies committed `HEAD` without modifying the checkout.

The optional third argument selects one example (`single-repository`,
`multi-repository`, `ci-runner`, `external-urls`, or `shared-upstream`) instead
of the compatible suite.

Complete adoption shapes belong under `projects/`; capability-focused and
one-off examples belong under `features/`.
