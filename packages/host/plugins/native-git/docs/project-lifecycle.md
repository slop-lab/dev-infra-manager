# Native Project and workspace lifecycle

A Project owns a catalog of independent repositories. Each repository has its
own protected ref, imported commit/tree, review policy, durable import draft and
receipt. Create the Project identity first, import each repository, then select
`configurationRepositoryId` and `defaultWorkingRepositoryId` from ready entries.
A failed or interrupted import leaves other repository bindings intact. Ready
means the native authority proved the import and transport, not that CI passed
or a human approved anything.

Every repository policy explicitly permits its `ciRepositoryIds` inputs. Workflow
code may select only a subset of that trusted allowlist. Approval, CI evidence
and protected-ref compare-and-swap are repository scoped. DIM does not offer a
distributed atomic promotion across repositories.

A workspace is one core UUID with persistent home, checkout and nested runtime
storage. For `dim://PROJECT`, acquisition checks out only the selected repositories
at `/workspace/REPOSITORY`. The default selection is the Project's default working
repository. `--workdir` must name a selected repository; an explicit subset that
omits the Project default uses its first selected repository unless overridden.
Configuration is independently read from the configuration repository at an
attested commit. An unselected configuration repository stays in host staging,
not in guest storage or Git grants. Required-plugin approval pins that
configuration commit, independently of the working directory.

Every selected checkout gets a distinct broker credential, repository-bound
short-lived write leases for ordinary unprotected branch/tag operations and its
own restricted legacy proposal namespace. Ordinary refs allow force and deletion;
direct protected writes, reserved internal refs and foreign scopes remain denied. Naming a
repository `public` does not enable anonymous Git access. Host operator credentials
never enter the checkout. There is one core lifecycle; managed Git owns source
acquisition and its scoped attachment, not a separate workspace runtime.

The broker validates the current core UUID and running/initialized phase on each
request. Stop denies transport; discard and display-name reuse revoke the old
attachment. Start/recreate preserve mutable files and repository grants. Host
reconnect may update the credential-file reference only after proving the original
authority and every pinned repository/ref/policy, including the configuration
source. Verified protected fast-forwards preserve the existing capability without
resetting local files. A changed review policy fails closed and requires explicit
new workspace intent.
