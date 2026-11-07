---
name: dim-native-ci
description: Request exact-candidate DIM CI and inspect its jobs, logs and artifacts from a managed repository checkout without host credentials.
---

Run `dim-workspace inspect` to discover this workspace's installed integrations,
then `dim-ci --help` inside the repository checkout. Each checkout's `origin`
selects its own repository. Never request host or operator credentials to read CI.

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
   before publishing any bytes. A manifest marked unavailable means collection was incomplete. Already listed
   immutable entries remain readable; missing entries are not proof. Collection
   availability does not change the execution result.
4. Fix the failure, commit and push, then create a **new request UUID** for the new
   commit. Retrying an unchanged request reuses its original candidate. Never
   describe queued work, missing artifacts or stale evidence as passed CI.

If the selected generation or policy is stale, report that state and ask the
operator to reconnect the workspace. Do not bypass the workspace boundary by
using host query commands or copying control-plane connection files.
