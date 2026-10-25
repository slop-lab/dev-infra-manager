# DIM Git contracts

Shared immutable repository selectors, canonical trusted-policy digests and
strict snapshot declarations. Feature policy sections belong to their plugins.
The `/http` export provides bounded HTTP(S) transport for Git service clients.
This package starts no services and loads no feature implementations.

Project discovery and attachment DTOs distinguish authority-owned repository
evidence from host-local selection. A catalog contains at most 1,024 Projects;
an attachment contains at most 64 completed repositories. Both responses are
bounded to 512 KiB UTF-8 and reject excess data instead of truncating it. An
attachment carries original import receipts/policies separately from effective
policies and current heads. Local names and repository defaults are not authority
catalog fields. Generation and ownership scope must match the authenticated
connection before a caller can use the descriptor.
