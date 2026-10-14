# Feature example: task that requires a TTY

> **Archived predecessor example.** Retained for historical source comparison;
> it is not a current native-only adoption path.

Some interactive development tools must refuse to start unless both standard
input and standard output are terminals. This example provides a deliberately
small program with that contract:

```bash
bash examples/features/tty-entrypoint/require-tty.bash
```

The linked self-Project verification invokes it through `dim workspace run`
twice. A normal non-interactive invocation must exit with status 1, while an
invocation under a pseudo-terminal must print `tty-required-ok`. This catches
`.dim/entrypoint.sh` implementations that always request a Compose TTY or
always disable one instead of following the caller's terminal state.
