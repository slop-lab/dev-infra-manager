FROM docker:29.1.3-dind@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5

ARG DIM_UID=1000
ARG DIM_GID=1000

RUN apk add --no-cache bash ca-certificates coreutils curl git jq just nodejs npm openssh-client openssh-server python3 shadow sudo tini flock \
  && groupadd --non-unique --gid "${DIM_GID}" dim \
  && useradd --non-unique --uid "${DIM_UID}" --gid dim --create-home --shell /bin/bash dim \
  && echo "dim ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dim \
  && chown root:root /etc/sudoers /etc/sudoers.d /etc/sudoers.d/dim \
  && if [ -e /etc/sudo.conf ]; then chown root:root /etc/sudo.conf; fi \
  && chmod 0755 /etc/sudoers.d \
  && chmod 0440 /etc/sudoers /etc/sudoers.d/dim

ENV HOME=/home/dim \
    DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST=unix:///var/run/docker.sock \
    PATH=/home/dim/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN npm install --global pnpm@10.13.1
RUN mkdir -p /mnt/dim-tmp && chown dim:dim /mnt/dim-tmp && chmod 0700 /mnt/dim-tmp
ENV TMPDIR=/mnt/dim-tmp DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp
RUN docker buildx version && docker compose version && flock --version
COPY agent-entrypoint.bash /usr/local/bin/dim-agent-entrypoint
COPY dim-workspace.mjs /usr/local/bin/dim-workspace
COPY dim-nproc /usr/local/bin/dim-nproc
COPY dim-workspace-ssh.bash /usr/local/bin/dim-workspace-ssh
RUN chmod 0555 /usr/local/bin/dim-agent-entrypoint /usr/local/bin/dim-workspace /usr/local/bin/dim-nproc /usr/local/bin/dim-workspace-ssh

WORKDIR /workspace
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/dim-agent-entrypoint"]
CMD ["sleep", "infinity"]
