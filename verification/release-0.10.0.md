# Internal development preparation: 0.10.0

This is a pre-stable internal-development target, not a stable release or an
announcement of registry availability. The production manifests, exact DIM
dependency/peer pins, lockfile, source version constants, and current examples
are aligned to `0.10.0`. Changelogs remain unreleased.

## Candidate identity

Preparation was performed in the working tree based on
`7ca8663c828206d9be5e8f6f17db37da00d22191`. That base commit is not the new
release candidate. Record the clean root SHA/tree of the committed candidate in
each execution's evidence according to
[`releasing.md`](../specification/docs/releasing.md). Do not run source
preparation or fresh-VM installation against the old base or a dirty checkout.

## Observed verification

| Surface | Result |
| --- | --- |
| Pinned isolated Node.js 24 source gate | Passed type checks, all package builds, 2,090 unit tests, 155 CLI tests, and 528 verification tests; one existing conditional unit skip |
| Ten production package dry-runs | Passed; each listing contains README, LICENSE, and package metadata |
| Real packed installer and plugin lifecycle | Passed install, durable reinstall, plugin enable/disable/removal, and incompatible-peer refusal in a clean process environment |
| Native idle service images | Passed live service-image, authenticated readiness, and owned-resource checks |
| Bootstrap CLI and sandbox journeys | Passed help, both role plans, invalid input, role execution, login resume, exact bundle/facade binding, and refusal paths |
| Shell syntax and whitespace | Passed |

The first packed-plugin smoke inherited this agent's mounted proxy environment
and failed with `EROFS` at `/run/dim/controller-proxy/resources.sock`. The same
artifacts and unchanged smoke passed with a clean process environment. No
mounted socket was changed.

Local run logs are retained under `.local/verification/0.10.0-*`; they are not
release package contents or independent-host acceptance evidence.

## Unavailable and remaining checks

- The live packaged control-plane gate built and pushed its disposable fixture
  images, but could not mount `/var/run/docker.sock` from this agent's Docker
  daemon environment. It did not complete. Its cleanup reported all fixed
  resources, registry, harness, shared volume, and images absent with status 0.
  Run `just verify control-plane-install-live` on a capable disposable host.
- Execute the new [Ubuntu VM bootstrap](bootstrap-ubuntu-vm.md) on fresh Ubuntu
  24.04 amd64 guests for both roles after the clean candidate commit exists.
  This environment has no accessible `/dev/kvm`; sandbox tests are not real
  Sysbox/KVM installation evidence. Re-run the two-node operations profile
  against that exact candidate rather than reusing the earlier `7ca8663c` run.
- Node.js 26 was not re-run in this preparation. The bootstrap's selected
  internal toolchain is explicitly Node.js 24.19.0.
- The LSP daemon was unavailable. Workspace TypeScript checks and executable
  tests passed instead; no clean LSP result is claimed.

TLS, private native role files, lingering, worker activation, and human protected
ref approval remain operator-owned. Full independent-host/public acceptance is
separate from this internal preparation. No release tag, public package
publication, public image publication, or persistent host deployment was made.
