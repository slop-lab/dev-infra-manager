#!/usr/bin/env sh
set -eu

install -d -m 0755 /run/sshd
chown -R dim-agent: /home/dim-agent
ssh-keygen -A
exec /usr/sbin/sshd -D -e
