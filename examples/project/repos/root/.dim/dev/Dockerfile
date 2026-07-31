FROM docker:29.1.3-dind

RUN apk add --no-cache bash git nodejs npm tini \
 && npm install --global @openai/codex @anthropic-ai/claude-code

COPY start.sh /usr/local/bin/start-dev

ENTRYPOINT ["/sbin/tini", "--", "/bin/sh", "/usr/local/bin/start-dev"]
