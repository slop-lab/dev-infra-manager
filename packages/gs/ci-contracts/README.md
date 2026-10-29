# @slop-lab/gs-ci-contracts

Portable CI workflow, immutable repository input, check event, evidence-provider
and review-status schemas. Workflow jobs and review status checks select a named
provider; status exposes `requiredChecks` and optional provider `runId`, not DIM
generation, worker-kind or execution identifiers. Workflow jobs do not
declare DIM worker kinds, images, resource profiles, Project identities or
scheduler generations.

DIM's persisted execution descriptor, placement profile and review-job event
wire codecs live in `@slop-lab/dim-contracts-ci`. Their existing bytes and
digest domains remain unchanged while GS public models stay placement-neutral.
