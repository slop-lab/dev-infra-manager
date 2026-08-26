FROM docker:29.1.3-dind-rootless

USER root
RUN apk add --no-cache su-exec \
  && mkdir -p /home/rootless/.local/share/docker /mnt/workspace-shared-dind \
  && chown -R rootless:rootless /home/rootless/.local/share/docker \
  && chmod 1777 /mnt/workspace-shared-dind

VOLUME /home/rootless/.local/share/docker

COPY entrypoint.sh /usr/local/bin/dim-rootless-dind-entrypoint
RUN chmod 0755 /usr/local/bin/dim-rootless-dind-entrypoint

ENTRYPOINT ["dim-rootless-dind-entrypoint"]
