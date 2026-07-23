FROM docker:29.1.3-dind

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN apk add --no-cache bash ca-certificates coreutils curl git jq just nodejs npm openssh-client shadow sudo tini \
  && groupadd --gid "${AGENT_GID}" agent \
  && useradd --uid "${AGENT_UID}" --gid agent --create-home --shell /bin/bash agent \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

ENV HOME=/home/agent \
    CODEX_HOME=/home/agent/.codex \
    DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST=unix:///var/run/docker.sock

RUN npm install --global pnpm@10 @openai/codex

COPY entrypoint.sh /usr/local/bin/dim-codex-entrypoint
RUN chmod +x /usr/local/bin/dim-codex-entrypoint

WORKDIR /workspace
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/dim-codex-entrypoint"]
CMD ["bash"]
