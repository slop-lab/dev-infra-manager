FROM docker:29.1.3-dind-rootless

USER root
RUN mkdir -p /mnt/workspace-shared-dind \
  && chown rootless:rootless /mnt/workspace-shared-dind
USER rootless
