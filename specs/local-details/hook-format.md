# Managed Git Hook Format

## File

Managed repositories install:

```text
<repo>.git/hooks/pre-receive
```

The hook mode must be executable.

## Generated Shape

The generated hook is a Bash script:

```bash
#!/usr/bin/env bash
set -euo pipefail

while read -r oldrev newrev refname; do
  case "$refname" in
  "refs/heads/main")
    echo "Direct pushes to protected ref '$refname' are blocked. Use the managed PR merge flow." >&2
    exit 1
    ;;
  esac
done
```

The case arms are generated from `managedGitHost.protectedRefs`.

## Behavior

- If any updated ref is protected, reject the entire push.
- If all updated refs are non-protected, allow the push.
- The hook does not inspect commit contents.
- The hook does not enforce review by itself; it only blocks direct protected-ref updates.

## Compatibility

Existing repositories can be updated with:

```bash
dim git-host install-hooks --repo <repo>
```

Changing `protectedRefs` requires reinstalling hooks for existing repositories.
