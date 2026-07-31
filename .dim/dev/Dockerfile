FROM docker:29.1.3-dind

RUN apk add --no-cache bash git jq nodejs npm just tini \
 && npm install --global pnpm@10.13.1 @openai/codex

COPY start.sh /usr/local/bin/start-dim-agent

ENTRYPOINT ["/sbin/tini", "--", "/bin/sh", "/usr/local/bin/start-dim-agent"]
