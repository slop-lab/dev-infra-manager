# Native Project and QEMU CI Without Gitea

**Kind: Decision record**

**Status: Accepted; implementation pending**

## Goal and current boundary

Fresh DIM Projects must be able to use native Git for repositories, human review,
and checked protected-ref promotion, and run both ordinary Sysbox CI and QEMU
integration CI without a Gitea service, Actions workflow, webhook, runner
registration, organization, or credential. Existing Gitea data need not be
imported. This decision does not enable native Project admission or QEMU
execution today: operator-configured native Git registrars can prepare empty
roots without issuing writer authority, but ordinary CI and the current QEMU scheduler remain
unavailable for native Projects until the replacement contracts are
implemented and verified.

## Proposed decisions

1. One fresh Project selects native Git exclusively. The host controller
   reconciles Project and repository identities through a trusted, durable
   native Project adapter. It admits only the exact registered native service,
   Project, repository, protected ref, and policy revision. An absent or stale
   identity, foreign resource, or unavailable service refuses before mutation.
   No Gitea fallback, dual write, implicit migration, or adoption by name is
   permitted. Protected-root reads and workspace Git transport use distinct
   read and proposal-only writer authority; agents cannot obtain a reviewer,
   registrar, host, or promoter credential.

2. Human approval is bound to the complete exact candidate commit and tree,
   not to a selected subset of files. Product maintainers review changed
   requirements, implementation, test definitions, and relevant results for
   correctness and regressions. The distinct, deeper infrastructure security
   review focuses on changes that could expose secrets, alter protected refs,
   reach host/runtime privilege, or elevate trusted capabilities, including
   their authority-bearing dependency closure; it is not a security audit of
   every product file. Promotion still compares the reviewed expected
   protected head with the current head and updates it only when they match
   (checked compare-and-swap), so approval cannot be reused after head drift.
   The existing limited DIM reviewer page can be deployed or a constrained
   CLI can expose the same exact review, approval, evidence, and promotion
   journey; feature parity with Gitea's web UI is not required. Review and
   promotion remain separate authorities.

3. The trusted host administrator sets global CI execution policy; every
   Project created through the trusted native lifecycle is automatically
   eligible without a separate CI approval, Project-specific runner
   registration, admission command, or refresh. Each workspace proposal push
   queues all valid jobs from the exact candidate `.dim/ci/runner.yml`, without
   a promoter creating a review or a human approving scripts, job names, or
   kinds first. The protected `requiredJobs` policy selects only the evidence
   needed for promotion. A candidate may add or change valid jobs without a
   policy change, but cannot create an eligible Project, change host membership,
   resource bounds, service credentials, or operator images.

4. QEMU is a distinct native integration capacity, not an ordinary Sysbox job,
   ordinary-result alias, or fallback. All Projects use operator-owned,
   digest-pinned common runner and job base images for **both** ordinary and
   QEMU capacities; neither a Project nor its candidate can select another
   image. The operator also fixes VM resource ceilings and the private guest
   Docker/cache boundary. Candidate-selected test scripts execute only inside
   the corresponding disposable job with runtime-fixed argv; no webhook or
   candidate may supply a host command or extra argv. The common images do not
   make candidate-selected tests independent: both QEMU and ordinary results carry
   `candidate-controlled` evidence class, their exact executable definition and
   provenance, and the distinct `qemu` or `ordinary-sysbox` execution kind. No
   user-facing surface may label either result independent.

5. Protected policy may require named QEMU and ordinary jobs separately.
   Missing, failed, stale, foreign, wrong-kind, or wrong-generation results
   cannot satisfy another slot. When QEMU is required, missing KVM or exhausted
   capacity reports unavailable and blocks promotion, never success or an
   ordinary-job substitute. When QEMU is optional, its failure remains visible
   but does not bypass an ordinary requirement or human approval.

6. The native QEMU event, claim, renewal, terminal-result, and cleanup path
   must use authenticated, durable, exact-attempt identities rather than
   Gitea `workflow_job` events or `act_runner` registration. A restarted or
   uncertain worker must inspect and reap only its exact owned VM/container
   before capacity is reusable. A result is promotable only after terminal
   evidence, cleanup, and the matching current candidate envelope are durable.
   Multiple ordinary and QEMU nodes register once through global operator
   configuration. Service outages retain queued work and retry after internal
   reconciliation; expired generations and leases remain fenced without an
   operator readmitting the Project.

## Implementation dependency and acceptance

Specify the corresponding Project/CLI, QEMU connection and evidence contracts
in `03-configuration.md`, `10-cli-contract.md`, `13-repo-workspace-lifecycle.md`,
and `14-installer-facade.md` before enabling any native mutation. Replace the
idle service entrypoints with activated native services; implement the Project
adapter, repository bootstrap, scoped writer/read authority and protected-root
resolution; wire ordinary admission and the host executor; then add native
QEMU demand and reporting without Gitea. Keep the current Gitea paths disabled
for native Projects rather than silently accepting mixed state.

A disposable clean-host gate must exercise, through the packaged facade and
real service/CLI surfaces: Project and root repository creation; workspace
proposal push and direct protected-write denial; exact review and approval;
both ordinary and QEMU candidate jobs in their respective isolation runtimes;
wrong-kind and missing-job denial; lost lease, restart, and foreign-resource
refusal; and checked promotion followed by a protected-root read. The QEMU
gate requires real KVM and must report missing hardware as unavailable, not
pass. Inspect the effective runtime for absence of any Gitea dependency,
socket, credential, registration, or fallback. Only after these gates pass may
the existing managed Gitea service be removed from a **fresh** native host.

## Relation to prior decisions

This decision retains the candidate-controlled evidence and human review
limitations of `0001-candidate-controlled-native-ordinary-ci.md` but
supersedes that record's target permission for a candidate-selected job image.
The current Gitea-only QEMU implementation and native-admission refusal remain
active until the replacement contracts, implementation, and acceptance gates
are complete.

## Clarification: independent readiness, security, and quality gates

The goal and clean-host acceptance scope above include both ordinary Sysbox
and native QEMU execution because the selected deployment must deliver and test
both capacities. That scope does not make either capacity, any CI result, or a
completed promotion a prerequisite for native Project or workspace readiness.
Readiness depends on registered owned native Project and repository state, the
protected-root snapshot, proposal-only authority, and selected runtime
prerequisites.

Protected promotion is a separate security gate. It always requires exact
current human approval and checked compare-and-swap. CI is a separately
configured Project quality gate whose required-job set may be empty, ordinary
only, QEMU only, or dual-kind. Promotion additionally requires successful
current CI evidence only for the jobs and execution kinds selected by that
policy. No runner, scheduler, capacity host, attempt issuer, or result reporter
can approve or promote.
