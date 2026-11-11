---
name: dim-native-ci
description: Request exact-candidate DIM CI and inspect its jobs, logs and artifacts from a managed repository checkout without host credentials.
---

Run `dim-workspace inspect` to discover this workspace's installed integrations,
then `dim-ci --help` inside the repository checkout. Each checkout's `origin`
selects its own repository. Never request host or operator credentials to read CI.

To change CI, edit `.dim/ci/runner.yml` and its referenced scripts in the
repository, then commit and request that exact candidate. For example:

```yaml
jobs:
  source:
    script: scripts/check.sh
  integration:
    script: scripts/integration.sh
    runtime: vm
```

Jobs default to containers; `runtime: vm` requests the shared QEMU capacity.
This works for any managed Project whose operator has enabled CI and configured
matching trusted capacity. The workflow cannot enable CI policy, choose worker
hosts/images/resources, or grant additional repositories. Report missing policy
or unavailable capacity to the operator; do not copy host credentials or start a
private worker to bypass it. The current request's `status` and `jobs` distinguish
queued, failed and successful work; they do not provision capacity.

The ordinary workspace does not need `/dev/kvm` or `dim-vm` to submit a VM job.
The job runs separately on a configured KVM host. Tests that create further VMs
inside that job require an operator-selected hardware runner with nested KVM;
`runtime: vm` alone does not guarantee that profile or install project tools.

1. Commit and push the candidate to an ordinary branch. Workspace CI does not
   promote protected refs, approve reviews, or change repository policy.
2. Generate a UUID and retain it with the exact candidate:

   ```sh
   REQUEST_ID=$(node -p 'crypto.randomUUID()')
   dim-ci request --request-id "$REQUEST_ID" --ref refs/heads/my-change
   dim-ci status --request-id "$REQUEST_ID"
   dim-ci jobs --request-id "$REQUEST_ID"
   ```

3. For a failed job, select its execution UUID from `jobs`, then inspect evidence:

   ```sh
   dim-ci logs --request-id "$REQUEST_ID" --job "$JOB_ID"
   dim-ci artifacts --request-id "$REQUEST_ID" --job "$JOB_ID"
   dim-ci download --request-id "$REQUEST_ID" --job "$JOB_ID" \
     --artifact "$ARTIFACT_ID" --output ./ci-failure-proof.zip
   ```

   `logs` verifies retained stdout/stderr and shows their final 64KiB, with source
   and truncation labels. Use `--stream stderr --tail-bytes 131072` for a larger
   selected tail, or `--stream stdout --output ./stdout.log` for the complete
   retained stream. If retention is unavailable, diagnostic prefixes are clearly
   labelled and cannot be saved as a complete retained log.
   Artifact names are descriptive metadata. They never choose local write paths.
   Downloads require an explicit new file and verify the declared size and SHA-256
   before publishing any bytes. A manifest marked unavailable means collection
   was incomplete. Already listed immutable entries remain readable only while
   the workspace grant, generation, policy, protected head and candidate still
   match the request; missing entries are not proof. Collection availability
   does not change the execution result. Save required logs and artifacts before
   pushing a changed candidate, promoting the protected ref, or changing policy
   or service generation. Durable retention does not guarantee later access
   through a stale workspace request.
4. Fix the failure, commit and push, then create a **new request UUID** for the new
   commit. Retrying an unchanged request reuses its original candidate. Never
   describe queued work, missing artifacts or stale evidence as passed CI.

For a stale workspace connection, report that state and ask the operator to
reconnect the workspace. A changed candidate, policy, protected head or service
generation requires a new explicit request UUID; reconnecting does not refresh
an old immutable request. Do not bypass the workspace boundary by using host
query commands or copying control-plane connection files.
