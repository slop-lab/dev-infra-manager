FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

ARG DIM_WORKSPACE_UID=1000
ARG DIM_WORKSPACE_GID=1000

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && test "${DIM_WORKSPACE_UID}" -ne 0 \
  && test "${DIM_WORKSPACE_GID}" -ne 0 \
  && existing_group="$(getent group "${DIM_WORKSPACE_GID}" | cut -d: -f1)" \
  && if test -n "$existing_group"; then \
       test "$existing_group" = dim-agent || groupmod --new-name dim-agent "$existing_group"; \
     else \
       groupadd --gid "${DIM_WORKSPACE_GID}" dim-agent; \
     fi \
  && existing_user="$(getent passwd "${DIM_WORKSPACE_UID}" | cut -d: -f1)" \
  && if test -n "$existing_user"; then \
       test "$existing_user" = dim-agent || usermod --login dim-agent "$existing_user"; \
       usermod --gid dim-agent --home /home/dim-agent --move-home --shell /bin/sh dim-agent; \
     else \
       useradd --uid "${DIM_WORKSPACE_UID}" --gid dim-agent --home-dir /home/dim-agent \
         --create-home --shell /bin/sh dim-agent; \
     fi

USER dim-agent
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
