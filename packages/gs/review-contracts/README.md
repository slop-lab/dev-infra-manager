# @slop-lab/gs-review-contracts

Portable namespace/principal-based review requests, envelopes, decisions and
reviewed-candidate projections. The package has no DIM
runtime, activation, HTTP, credential, scheduler or storage dependency.

`ReviewRequest` uses neutral namespace/repository selectors and has one optional
`requesterPrincipalId`; PR and other callers do not need a review runtime type.
The root export contains only neutral GS models. `./dim-legacy-codec` owns the
explicit persisted/wire mapping that retains `projectId`, `workspaceId`,
`serviceId: "native-main"`, existing schema versions and every `dim-*` digest
domain byte-for-byte.
