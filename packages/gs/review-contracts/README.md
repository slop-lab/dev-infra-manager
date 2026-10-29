# @slop-lab/gs-review-contracts

Portable review requests, reviewed-candidate projections and the canonical
persisted review, approval and revocation schemas. The package has no DIM
runtime, activation, HTTP, credential, scheduler or storage dependency.

`ReviewRequest` uses neutral namespace/repository selectors and has one optional
`requesterPrincipalId`; PR and other callers do not need a review runtime type.
Persisted records deliberately retain `projectId`, `serviceId: "native-main"`,
`dim-*` digest domains and schema versions because those bytes are durable ABI.
