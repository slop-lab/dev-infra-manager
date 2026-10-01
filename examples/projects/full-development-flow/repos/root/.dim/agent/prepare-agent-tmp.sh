#!/bin/sh
set -eu

agent_tmpdir="${DIM_AGENT_TMPDIR:?}"
expected_owner="${DIM_AGENT_UID:?}:${DIM_AGENT_GID:?}"
expected_mode=700

test ! -L "$agent_tmpdir" || {
  echo "agent temporary root must not be a symbolic link: $agent_tmpdir" >&2
  exit 1
}
test "$(stat -c %F "$agent_tmpdir")" = directory || {
  echo "agent temporary root must be a directory: $agent_tmpdir" >&2
  exit 1
}

actual_owner="$(stat -c %u:%g "$agent_tmpdir")"
actual_mode="$(stat -c %a "$agent_tmpdir")"
if [ "$actual_owner" = "$expected_owner" ] && [ "$actual_mode" = "$expected_mode" ]; then
  exit 0
fi
if [ -n "$(find "$agent_tmpdir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "agent temporary root has incompatible ownership or mode: expected $expected_owner mode $expected_mode, found $actual_owner mode $actual_mode" >&2
  exit 1
fi

chown "$expected_owner" "$agent_tmpdir"
chmod "$expected_mode" "$agent_tmpdir"
