FROM docker:29.1.3-dind

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN apk add --no-cache bash ca-certificates coreutils curl git jq just nodejs npm openssh-client shadow sudo tini \
  && groupadd --non-unique --gid "${AGENT_GID}" agent \
  && useradd --non-unique --uid "${AGENT_UID}" --gid agent --create-home --shell /bin/bash agent \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

ENV HOME=/home/agent \
    CODEX_HOME=/home/agent/.codex \
    DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST=unix:///var/run/docker.sock \
    PATH=/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN npm install --global pnpm@10 @openai/codex

COPY entrypoint.sh /usr/local/bin/dim-project-entrypoint
COPY git-askpass.sh /usr/local/bin/dim-git-askpass
RUN chmod +x /usr/local/bin/dim-project-entrypoint /usr/local/bin/dim-git-askpass

WORKDIR /workspace
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/dim-project-entrypoint"]
CMD ["bash"]
