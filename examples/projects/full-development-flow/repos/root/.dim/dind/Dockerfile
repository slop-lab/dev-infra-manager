FROM docker:29.1.3-dind-rootless

USER root
# Nested image stores may discard the base image's file capabilities. The
# setuid mode is shadow-utils' supported fallback for rootless UID/GID maps.
# The entrypoint reapplies it after every outer workspace restart.
RUN mkdir -p /mnt/workspace-shared-dind \
  && chmod 1777 /mnt/workspace-shared-dind \
  && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap \
  && apk add --no-cache su-exec
COPY entrypoint.sh /usr/local/bin/dim-rootless-dind-entrypoint
RUN chmod 0755 /usr/local/bin/dim-rootless-dind-entrypoint

ENTRYPOINT ["dim-rootless-dind-entrypoint"]
