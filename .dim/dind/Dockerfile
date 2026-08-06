FROM docker:29.1.3-dind-rootless

USER root
RUN mkdir -p /mnt/workspace-shared-dind \
  && chmod 1777 /mnt/workspace-shared-dind
USER rootless
