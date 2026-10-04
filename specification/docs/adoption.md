# Adopting DIM Safely

DIM controls development containers and can affect environments that hold
secrets. The following requirements apply before another project adopts or
updates DIM.

## Required human review

A human reviewer must directly review all of the following at the exact
revision that will run:

1. The complete DIM repository, including controller, CLI, container,
   installation, and infrastructure code.
2. The complete project repository used by DIM, not only its `.dim` directory.
3. All code and configuration that builds, starts, deploys, or otherwise
   controls a secret-bearing container or environment. This includes
   Dockerfiles, Compose files, setup and entrypoint scripts, base images,
   dependencies, controller configuration, plugins, and deployment manifests.

Agent output, automated checks, and a review limited to the changed lines do
not replace this full human trust review. Repeat the review whenever any of
these inputs or their pinned versions change.

This trust review has a specific infrastructure-security purpose: establish
the code that can expose secrets, mutate protected refs, control host/runtime
privileges, or elevate another trusted capability. Keeping that authority
closure small reduces security-review burden only. It does not reduce the
separate product/QA review needed for a change. Product maintainers must still
review changed requirements, implementation, test definitions, and relevant
results sufficiently to judge behavior and regression risk.

The review gate protects promotion into a protected ref or secret-bearing
runtime. It does not make the mutable agent workspace trusted. Verification
jobs also execute untrusted proposed input and must not be treated as a place
for long-lived project secrets.

Candidate-controlled native ordinary CI may run before infrastructure trust
review because its fixed sandbox supplies no such secrets or trusted
capabilities. Before promotion, its config and tests remain part of the exact
candidate subject to product/QA review. A green result records successful
bounded execution of the selected tests. It does not independently establish
that the tests are correct or complete, or that the product has no regression.

### What actually keeps secrets safe

The full review above is the basis on which a project accepts DIM's correctness,
availability, and other behavior; review and green CI do not prove those
properties. Secret safety specifically rests on a narrower guarantee: an
agent container never receives raw secret material, because reviewed Project
configuration and task dispatch do not pass it there, and secret-bearing
containers are built and deployed by trusted Project lifecycle authority
outside the agent container and its private runtime (see
[Architecture](architecture.md)). That guarantee
depends only on (3) above — the secret-bearing code and configuration
itself — staying correct, plus the specific parts of DIM that enforce the
boundary (workspace container/environment construction and protected-ref
Git policy), not the full agent-facing CLI surface in (1). A bug in, say,
`dim project list`'s JSON output cannot leak a secret; a bug in what
environment variables a workspace container receives could. Reviewing (3)
well is what keeps secrets specifically safe even under time pressure; the
full review in (1)-(2) is what a project needs before trusting DIM more
broadly.

This narrower secret-safety dependency closure is not a shortcut for product
maintenance. Requirements, ordinary implementation, tests, and observed
results can be product-critical without being secret-bearing, and maintainers
must review them on that basis.

## Pin every version

Consumers must use immutable, exact versions. Do not track `latest`, a moving
branch, or an unbounded package range. Pin:

- DIM CLI, core, installer, and plugins to exact package versions.
- Source installations to a reviewed release tag or full commit SHA.
- Container base images and deployed images to reviewed immutable digests where
  practical.
- Project dependencies through the ecosystem lockfile.

For example:

```bash
npm install --global "@slop-lab/dim-cli@0.9.0"
npx '@slop-lab/dim-installer@0.9.0' installer install plugin '@company/dim-plugin@1.2.3'
```

Treat the example versions as placeholders and select versions whose complete
source and artifacts were reviewed by your project.

DIM has no stable release and does not promise backward compatibility between
`0.x` versions. Before upgrading, push important workspace changes, review the
complete new release, and follow any explicit replacement procedure instead
of assuming old state, configuration, CLI, or plugin contracts will migrate.

## Repository branches

Ongoing development of this repository happens on `development`, not `main`.
Changes are promoted to `main` only after human review. Consumers must not run
directly from either moving branch; use a reviewed release tag, full commit
SHA, or exact published package version.
