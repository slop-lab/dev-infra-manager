# Candidate-Controlled Native Ordinary CI

**Kind: Decision record**

**Status: Accepted**

## Decision

Native ordinary CI reads `.dim/ci/runner.yml` and its named script from the
exact candidate Git tree, not from the protected head. The candidate may choose
the digest-pinned disposable job image and the script bytes within the strict
schema and sandbox fixed by `CI-NATIVE-CANDIDATE-JOB-001`.

The protected required-job policy may accept a successful native ordinary job
as a promotion condition. That result is candidate-controlled self-test
evidence. It is not independent CI and must never be described as independent
verification. Success records that the candidate-selected tests executed within
the recorded bounds and the bound process exited successfully. That is useful,
limited product/QA evidence when maintainers review the test definition and
result; it is not blanket proof of product correctness.

The operator still controls Project and repository eligibility, protected-ref
policy, required job names and evidence classes, host membership, capacity,
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

Project admission and script trust are separate questions. Admission says an
operator permits an eligible Project to consume bounded capacity and submit the
named evidence required by protected policy. It does not make candidate job
bytes pre-reviewed or trusted as infrastructure. Those bytes remain part of the
candidate that product maintainers review before promotion.

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
- The earlier target contract that admitted a protected-head runner definition
  is intentionally superseded. DIM is pre-stable, so no compatibility parser,
  dual format, or state migration is defined.
- Native Git implements the strict schema-2 descriptor-bound attempt, terminal
  evidence, verifier gate, and promotion checks. The native Project adapter,
  authenticated ordinary-service verifier client, scheduler path, and host
  executor remain unimplemented; without that client the production gate fails
  closed.

## Supersedes

This record supersedes the protected-snapshot ordinary admission semantics
previously stated by `CI-ORDINARY-POOL-001` and `CI-JOB-IMAGE-001`. It does not
change protected QEMU cache-hook or predecessor Gitea runner admission.
