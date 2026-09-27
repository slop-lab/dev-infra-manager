#!/usr/bin/env sh
set -eu

dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
for attempt in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  if [ "$attempt" -eq 60 ]; then
    cat /var/log/dockerd.log >&2
    exit 1
  fi
  sleep 1
done

docker container inspect deep >/dev/null 2>&1 || \
  docker run --detach --name deep --publish 18082:5678 \
    hashicorp/http-echo:1.0 -text=hello-from-deep

mkdir -p /srv/dev
printf 'hello-from-dev\n' > /srv/dev/index.html
exec httpd -f -p 8080 -h /srv/dev
