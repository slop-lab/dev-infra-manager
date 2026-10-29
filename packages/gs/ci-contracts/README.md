# @slop-lab/gs-ci-contracts

Portable CI workflow, immutable repository input, candidate execution descriptor,
event and review-status schemas. The package does not contain scheduler state,
worker placement, credentials, HTTP transport or DIM configuration aggregates.

Existing serialized event names, descriptor fields and digest domains remain
unchanged because they are persisted protocol ABI.
