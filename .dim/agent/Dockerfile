FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS node
FROM docker@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS docker-cli
FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq just tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/bin/docker-compose /usr/local/bin/docker-compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
RUN npm install --global pnpm@10.13.1 @openai/codex@0.149.0

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
