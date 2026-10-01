FROM docker:29.1.3-dind-rootless

USER root
RUN mkdir -p /mnt/workspace-shared-dind \
  && chmod 1777 /mnt/workspace-shared-dind \
  && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap \
  && apk add --no-cache su-exec
COPY entrypoint.sh /usr/local/bin/dim-secure-dind-entrypoint
RUN chmod 0755 /usr/local/bin/dim-secure-dind-entrypoint

ENTRYPOINT ["dim-secure-dind-entrypoint"]
