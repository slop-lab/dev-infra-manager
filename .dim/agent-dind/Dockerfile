FROM docker:29.1.3-dind

RUN mkdir -p /mnt/workspace-shared-dind \
  && chmod 1777 /mnt/workspace-shared-dind \
  && apk add --no-cache jq
COPY entrypoint.sh /usr/local/bin/dim-rootless-dind-entrypoint
COPY agent.sh /usr/local/bin/dim-agent-dind
RUN chmod 0755 /usr/local/bin/dim-rootless-dind-entrypoint /usr/local/bin/dim-agent-dind

ENTRYPOINT ["dim-rootless-dind-entrypoint"]
