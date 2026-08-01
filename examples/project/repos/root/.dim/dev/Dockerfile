FROM docker:29.1.3-cli

RUN apk add --no-cache bash git nodejs npm tini \
 && npm install --global @openai/codex @anthropic-ai/claude-code

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
