FROM docker:29.1.3-cli

RUN apk add --no-cache bash git jq nodejs npm just tini \
 && npm install --global pnpm@10.13.1 @openai/codex

COPY tool-cgroup.sh /usr/local/bin/dim-tool-cgroup
RUN chmod 0755 /usr/local/bin/dim-tool-cgroup

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
