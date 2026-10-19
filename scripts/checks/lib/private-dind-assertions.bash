#!/usr/bin/env bash

dim_assert_private_dind_unix_only() {
  local container="$1"
  local expected_socket="$2"

  docker exec "$container" sh -eu -c '
    expected_socket="$1"
    dockerd_pid="$(pidof dockerd)"
    test -n "$dockerd_pid"
    test "${dockerd_pid#* }" = "$dockerd_pid"
    set -- $(tr "\000" "\n" <"/proc/$dockerd_pid/cmdline")
    test "$#" -eq 2
    test "$1" = dockerd
    test "$2" = "--host=unix://$expected_socket"

    rootlesskit_pids="$(pidof rootlesskit)"
    test -n "$rootlesskit_pids"
    port_driver_found=false
    for rootlesskit_pid in $rootlesskit_pids; do
      tr "\000" "\n" <"/proc/$rootlesskit_pid/cmdline" > /tmp/dim-rootlesskit-argv
      if grep -qx -- --port-driver=builtin /tmp/dim-rootlesskit-argv; then
        port_driver_found=true
      fi
      if grep -Eq -- "(^-p$|2375|2376)" /tmp/dim-rootlesskit-argv; then
        echo "rootlesskit unexpectedly forwards Docker TCP authority" >&2
        exit 1
      fi
    done
    test "$port_driver_found" = true

    for sockets in /proc/net/tcp /proc/net/tcp6; do
      awk '\''NR > 1 && $4 == "0A" {
        split($2, endpoint, ":")
        if (endpoint[2] == "0947" || endpoint[2] == "0948") exit 1
      }'\'' "$sockets" || {
        echo "private Docker daemon unexpectedly listens on TCP 2375 or 2376" >&2
        exit 1
      }
    done
    test -S "$expected_socket"
  ' sh "$expected_socket"
}
