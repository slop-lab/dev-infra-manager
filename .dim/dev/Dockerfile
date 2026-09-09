FROM docker:29.1.3-cli

ARG DIM_UID=1000
ARG DIM_GID=1000

RUN apk add --no-cache bash git jq nodejs npm just shadow tini \
  && groupadd --non-unique --gid "${DIM_GID}" dim-agent \
  && useradd --non-unique --uid "${DIM_UID}" --gid dim-agent \
    --home-dir /home/dim-agent --create-home --shell /bin/bash dim-agent \
  && npm install --global pnpm@10.13.1 @openai/codex

COPY tool-cgroup.sh /usr/local/bin/dim-tool-cgroup
RUN chmod 0755 /usr/local/bin/dim-tool-cgroup

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
