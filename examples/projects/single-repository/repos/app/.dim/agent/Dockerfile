FROM docker:29.1.3-cli

RUN apk add --no-cache bash curl git nodejs npm tini \
 && npm install --global @openai/codex @anthropic-ai/claude-code

COPY start.sh /usr/local/bin/start-single-app

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "/usr/local/bin/start-single-app"]
