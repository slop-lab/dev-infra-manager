FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS node
FROM docker@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS docker-cli
FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ARG TARGETARCH=amd64

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq tini \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) just_target=x86_64; just_sha=6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc ;; \
      arm64) just_target=aarch64; just_sha=e28e1f18cecd45d35f9fb39ef3651dd79c0623cb29a2f375ea7a1a185ac32dc9 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/just.tar.gz "https://github.com/casey/just/releases/download/1.43.1/just-1.43.1-${just_target}-unknown-linux-musl.tar.gz"; \
    echo "$just_sha  /tmp/just.tar.gz" | sha256sum --check; \
    tar -xzf /tmp/just.tar.gz -C /usr/local/bin just; \
    rm /tmp/just.tar.gz
COPY --from=node /usr/local/ /usr/local/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/bin/docker-compose /usr/local/bin/docker-compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code \
      pnpm@10.13.1 @openai/codex@0.149.0 @anthropic-ai/claude-code@2.1.238

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
