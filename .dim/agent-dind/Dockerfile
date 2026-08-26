FROM docker:29.1.3-dind-rootless

ARG DIM_UID=1000
ARG DIM_GID=1000

USER root
RUN apk add --no-cache jq shadow su-exec \
  && test "${DIM_UID}" -ne 0 \
  && groupmod --gid "${DIM_GID}" rootless \
  && usermod --uid "${DIM_UID}" --gid "${DIM_GID}" rootless \
  && chown -R rootless:rootless /home/rootless \
  && mkdir -p /mnt/workspace-shared-dind \
  && chmod 1777 /mnt/workspace-shared-dind \
  && chown root:root /usr/bin/newuidmap /usr/bin/newgidmap \
  && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap
ENV HOME=/home/rootless \
    XDG_RUNTIME_DIR=/run/user/${DIM_UID} \
    DOCKER_HOST=unix:///run/user/${DIM_UID}/docker.sock
COPY entrypoint.sh /usr/local/bin/dim-rootless-dind-entrypoint
COPY agent.sh /usr/local/bin/dim-agent-dind
RUN chmod 0755 /usr/local/bin/dim-rootless-dind-entrypoint /usr/local/bin/dim-agent-dind

ENTRYPOINT ["dim-rootless-dind-entrypoint"]
