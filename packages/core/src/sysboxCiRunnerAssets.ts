export const SYSBOX_CI_RUNNER_BASE_IMAGE =
  "gitea/act_runner@sha256:578925b4bdec5f60d93b5ba766cf02f2f9f32b1c8a4ec665ddf4d53d45f683c7";

export const SYSBOX_CI_RUNNER_IMAGE =
  "dev-infra-manager-ci-runner:act-runner-node-24.19.0-just-1.40.0-jq-socat-util-linux";

export const SYSBOX_CI_RUNNER_DOCKERFILE = `FROM ${SYSBOX_CI_RUNNER_BASE_IMAGE}
RUN apk add --no-cache jq just=1.40.0-r0 libgcc=14.2.0-r6 libstdc++=14.2.0-r6 socat util-linux \
    && wget -q -O /tmp/node.tar.xz https://unofficial-builds.nodejs.org/download/release/v24.19.0/node-v24.19.0-linux-x64-musl.tar.xz \
    && echo "ebcb19941bf6a34ada2141727ffda66fb2a4bf315f5c02c8f1fc9e48a2045e06  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && rm /tmp/node.tar.xz
COPY health.bash /usr/local/bin/dim-ci-runner-health
RUN chmod 0755 /usr/local/bin/dim-ci-runner-health
RUN node --version && just --version && script --version && git --version && docker --version && act_runner --version
`;

export const SYSBOX_CI_RUNNER_HEALTH_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail

recover=false
[[ "\${1:-}" != --recover ]] || recover=true
probe="$(mktemp -d /tmp/dim-ci-runner-health.XXXXXX)"
cleanup() {
  umount "$probe" >/dev/null 2>&1 || true
  rmdir "$probe" >/dev/null 2>&1 || true
}
trap cleanup EXIT

failure=""
if ! mount -t tmpfs -o size=1m tmpfs "$probe"; then
  failure="Sysbox mount mediation is unhealthy"
elif ! umount "$probe"; then
  failure="Sysbox unmount mediation is unhealthy"
elif ! docker info >/dev/null; then
  failure="runner Docker daemon is unhealthy"
elif ! docker run --rm alpine:3.22 true >/dev/null; then
  failure="runner Docker mount/container probe failed"
fi

if [[ -z "$failure" ]]; then
  echo dim-ci-runner-health-ok
  exit 0
fi

echo "error: $failure" >&2
if [[ "$recover" == true ]]; then
  echo "restarting the managed runner container before it can accept another job" >&2
  nohup sh -c 'sleep 5; kill -TERM 1' >/dev/null 2>&1 &
fi
exit 1
`;
