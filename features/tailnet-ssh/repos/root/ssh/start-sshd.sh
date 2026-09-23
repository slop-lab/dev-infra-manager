#!/bin/sh
set -eu

for type in rsa ecdsa ed25519; do
  key="/var/lib/ssh-host-keys/ssh_host_${type}_key"
  test -s "$key" || ssh-keygen -q -N '' -t "$type" -f "$key"
done

exec /usr/sbin/sshd -D -e \
  -o AllowUsers=developer \
  -o PasswordAuthentication=no \
  -o PermitRootLogin=no \
  -o HostKey=/var/lib/ssh-host-keys/ssh_host_rsa_key \
  -o HostKey=/var/lib/ssh-host-keys/ssh_host_ecdsa_key \
  -o HostKey=/var/lib/ssh-host-keys/ssh_host_ed25519_key
