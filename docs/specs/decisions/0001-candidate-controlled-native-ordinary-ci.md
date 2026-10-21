# Candidate-Controlled Native Ordinary CI

**Kind: Decision record**

**Status: Accepted**

## Decision

When explicitly selected, the Git-CI control-plane plugin uses its selected
workflow compiler to read `.dim/ci/runner.yml` and its named script from the
exact candidate Git tree, not from the protected head. The candidate may choose
job names and script bytes within the strict schema and sandbox fixed by
`CI-NATIVE-CANDIDATE-JOB-001`. The operator chooses the digest-pinned job and
runner base images and all resource limits.

With Git-CI enabled, every create or fast-forward update of a workspace-scoped proposal ref
automatically queues every valid job in that exact candidate tree. Trusted
native Project registration supplies eligibility centrally. There is no
per-Project runner registration, admission command, repeated policy refresh,
host-promoter review-create action, or human approval of a job name, kind,
config, or script before execution. A candidate may add or change valid jobs
without changing protected policy.

The protected required-job policy selects a subset of successful native jobs
as promotion conditions. It does not select which candidate jobs run. Each
result is candidate-controlled self-test
evidence. It is not independent CI and must never be described as independent
verification. Success records that the candidate-selected tests executed within
the recorded bounds and the bound process exited successfully. That is useful,
limited product/QA evidence when maintainers review the test definition and
result; it is not blanket proof of product correctness.

The operator still controls trusted Project registration, protected-ref
policy, required promotion job names and evidence classes, host membership, capacity,
resource ceilings, the digest-pinned runner base, and service credentials. A
candidate controls only bytes executed inside one fixed, bounded, ephemeral
Sysbox job. A webhook cannot supply an image, command, argument, script, path,
environment value, resource limit, or credential.

Human approval remains mandatory for the exact commit and tree. Promotion
still rereads current approval and job evidence and uses the same serialized
compare-and-swap from the reviewed expected head to the reviewed candidate.
Approval includes product/QA judgment over changed requirements,
implementation, test definitions, and relevant results. Where a change affects
secret exposure, protected refs, host/runtime privilege, or another trusted
capability, approval also includes the distinct infrastructure security
judgment for that authority-bearing dependency closure.

## Why

This design gives a proposal a simple way to add or change its own tests while
keeping execution away from the workspace and host control plane. It does not
pretend that an attacker-controlled test can independently judge the attacker.
The infrastructure security claim comes from sandboxing, exact provenance,
credential and capability denial, protected-ref policy, and the checked
promotion transaction, not from the self-test's choice of work or a generic
claim that all product code was security-reviewed.

Product correctness is a separate concern. Requirements can change, tests can
be incomplete or wrong, and implementations can regress while a selected suite
still exits zero. Product maintainers therefore review changed requirements,
implementation, tests, and results together. DIM's effort to minimize review
applies only to the security-sensitive surface that can expose secrets or
elevate trusted authority; it does not minimize product or test review.

Project eligibility and script trust are separate questions. Trusted native
registration permits a Project to consume bounded global capacity. It does not
make candidate job bytes pre-reviewed or trusted as infrastructure. Those
bytes may run before review and remain part of the candidate that product
maintainers assess before protected promotion.

## Consequences

- Reviewers must inspect the candidate CI definition and script as part of the
  complete tree, relate changed tests to changed requirements and
  implementation, inspect relevant results, and see that the resulting evidence
  is candidate controlled.
- The scheduler and executor must bind one attempt to the exact candidate
  tuple, config blob, script blob, normalized argv, job image digest, runner
  base digest, and resource bounds. Stale or partial replay cannot satisfy a
  current attempt.
- The execution boundary may safely run arbitrary candidate behavior only
  inside the stated sandbox. It carries no host Docker socket, DIM or Git
  credential, `/dev/kvm`, secret, or promotion authority.
- Projects that need independent CI must add a separate executor whose command
  definition is outside candidate control and whose evidence is labeled
  `independent`.
- Neither candidate-controlled nor independent green CI is blanket proof of
  product correctness. The evidence claim is limited to the checks actually
  selected and executed; maintainers own requirements, coverage, and regression
  judgment.
- Git-CI validates descriptor-bound attempts, terminal evidence and current
  repository inputs. Merge-policy checks selected quality evidence and human
  decisions, then requests the repository engine's checked CAS. The shared execution scheduler coordinates
  authenticated workers, while host executors own isolated runtime creation and
  cleanup. Unavailable authority or unverifiable evidence fails closed.
- Service restart, generation rollover, lease expiry, and dependency outage
  must reconcile eligibility and retry durable queued work internally. They
  must not require another proposal push or operator readmission.

## Clarification: optional quality policy

Repository hosting and human review can run without Git-CI or a compiler.
This decision classifies native ordinary evidence whether or not a Project
quality policy selects the job for promotion. It does not require a Project to configure CI,
does not make ordinary capacity or results a Project or workspace readiness
condition, and does not grant any runner or CI identity approval or promotion
authority. A quality policy may contain no jobs. Protected promotion always
requires exact current human approval and checked compare-and-swap; successful
CI is an additional condition only for jobs that the current quality policy
selects.
