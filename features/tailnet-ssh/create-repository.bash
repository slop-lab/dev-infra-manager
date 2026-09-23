#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-$PWD/example-repositories}"
public_key="${DIM_TAILNET_SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
repo_root="$(cd -- "$example_dir/../../.." && pwd)"
# shellcheck source=../../../verification/scripts/lib/example-repositories.bash
source "$repo_root/verification/scripts/lib/example-repositories.bash"

test -f "$public_key" || {
  printf 'SSH public key not found: %s\n' "$public_key" >&2
  exit 2
}
ssh-keygen -l -f "$public_key" >/dev/null
dim_materialize_example_repositories "$example_dir" "$destination"
install -m 0644 "$public_key" "$destination/root/ssh/authorized_keys"
GIT_MASTER=1 git -C "$destination/root" add ssh/authorized_keys
GIT_MASTER=1 git -C "$destination/root" commit --amend --no-edit >/dev/null
printf 'Created repository in %s/root with authorized key %s\n' "$destination" "$public_key"
