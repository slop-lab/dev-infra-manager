---
name: prepare-release
description: Prepare a repository release by reconciling versions, changelog entries, package metadata, documentation, examples, specifications, build and publish instructions, automated CI, manual gates, and tag state. Use when cutting or auditing a release candidate, updating release documentation, checking whether a repository is ready to publish, or identifying work remaining before a release.
---

# Prepare Release

Prepare the release candidate completely, but distinguish preparation from
irreversible publication. Follow repository instructions such as `AGENTS.md`
and the repository's own release guide before this skill.

## Establish scope

- Determine the intended version, release ref, supported runtimes, packages,
  artifacts, registries, and manual gates from repository files.
- Inspect the worktree before editing. Preserve unrelated user changes.
- Clarify only actions that materially change external state. Do not infer
  authorization to publish packages, create tags or releases, or deploy.
- Treat an explicit exclusion such as "publish elsewhere" as a hard boundary.

## Reconcile release content

- Find every authoritative and user-facing occurrence of the current and prior
  versions. Check root and package manifests, exact internal dependencies,
  lockfiles, install examples, status documents, and release links.
- Ensure the changelog has the intended version and date, an accurate summary,
  and correct comparison links.
- Compare changed behavior with specifications, package READMEs, top-level
  documentation, examples, help output, configuration references, and the
  release guide. Update all affected surfaces together.
- Search for stale commands, paths, package names, flags, runtime assumptions,
  and obsolete compatibility guidance. Do not rely only on files already
  changed in the release diff.
- Verify installation and publication examples use the intended package
  manager boundary. Keep build tooling separate from the registry client when
  nesting them leaks incompatible configuration.

## Verify artifacts

- Run the repository's formatting, static checks, tests, builds, audits, and
  supported runtime matrix in the documented order.
- Perform package dry-runs without publishing. Inspect each archive listing for
  its manifest, license, README, runtime files, and absence of secrets or
  unintended local artifacts.
- Confirm generated manifests have the intended version, entry points, engine
  constraints, files, executable mappings, and exact internal dependencies.
- Exercise install and integration smoke tests in proportion to the release's
  affected boundaries. Run required container, VM, or self-hosted gates rather
  than treating a workflow dispatch alone as execution.
- Record environmental or external failures separately from product failures,
  but diagnose repeated failures before calling them transient.

## Audit release state

- Confirm the candidate commit is pushed when remote CI is required.
- Confirm automated and manual runs used the exact candidate commit, not merely
  the same branch name, and completed successfully.
- Check that the intended tag and release do not already exist locally or on
  the remote.
- Recheck the worktree after verification. Generated or cached files must not
  silently become release content.
- Review the final commit range and state exactly which steps remain.

## Handoff

- Lead with whether the candidate is ready, conditionally ready, or blocked.
- List the exact candidate version and commit, verification results, remote run
  links when available, and remaining authorized actions.
- Explicitly identify publication, tagging, release creation, signing, or
  deployment actions that were intentionally not performed.
