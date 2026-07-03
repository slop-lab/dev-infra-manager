FROM docker:29.1.3-dind

RUN apk add --no-cache \
    bash \
    ca-certificates \
    coreutils \
    curl \
    git \
    jq \
    openssh-client \
    sudo \
    tini

RUN addgroup -S agent && adduser -S -G agent -s /bin/bash agent \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

COPY entrypoint.sh /usr/local/bin/dev-infra-agent-entrypoint
RUN chmod +x /usr/local/bin/dev-infra-agent-entrypoint

ENV DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST="unix:///var/run/docker.sock"

WORKDIR /workspace
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/dev-infra-agent-entrypoint"]
CMD ["bash"]
