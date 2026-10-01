# Self-Project smoke phases

The self-Project smoke creates one disposable Project and workspace, then runs
named verification phases in registration order. List the stable selectors
without allocating managed state:

```bash
bash verification/scripts/container-self-project-smoke.bash --list-phases
```

With no selector, the gate runs `workspace`, `ssh`, `agent`, `publication`, and
`retained-volume`. Select one or more phases when replaying a failure:

```bash
bash verification/scripts/container-self-project-smoke.bash --phase retained-volume
bash verification/scripts/container-self-project-smoke.bash --phase ssh --phase agent
DIM_SELF_PHASES=publication,retained-volume just verify self-development
```

`just verify self-development` keeps its package and workspace-image builds for
selected runs. Selection does not accept an old build implicitly.

Every invocation still performs mandatory source, Project, and initial
workspace setup. Phase selection avoids unrelated checks after that setup; it
does not reuse a warm VM or workspace from an earlier invocation. The
`retained-volume` phase prepares only its required SSH key and initial host-key
evidence when `ssh` was not selected.

Selected independent phases continue after a failure. A phase's dependency
list is a failure barrier only among phases selected in the same invocation:
an omitted phase does not block a targeted replay, while a selected failed or
skipped phase prevents unsafe selected dependents. The final summary reports
pass, failure, skip, duration, and log directory, and any failure or skip makes
the invocation nonzero.

Each phase writes a mode-`0600` log beneath a mode-`0700` run directory outside
the cleanup-owned DIM state. Override the selected directory with
`DIM_SELF_PHASE_LOG_ROOT`; the summary prints the exact path. The harness does
not enable shell tracing or intentionally print credentials.

The lightweight behavioral driver exercises the same selection and failure
barrier implementation without Docker or QEMU:

```bash
bash verification/scripts/self-project-phase-runner-smoke.bash --phase retained-volume
DIM_PHASE_DRIVER_FAILURES=workspace \
  bash verification/scripts/self-project-phase-runner-smoke.bash \
    --phase workspace --phase retained-volume
bash verification/scripts/self-project-phase-runner-smoke.bash
```

The first command runs only `retained-volume`. The second fails `workspace`,
skips the selected destructive dependent, and exits nonzero. The last command
runs all five phases.
