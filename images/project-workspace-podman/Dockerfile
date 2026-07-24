FROM quay.io/podman/stable:v5.6.2

RUN dnf install -y \
    bash \
    coreutils \
    curl \
    git \
    jq \
    nodejs \
    npm \
    openssh-clients \
    podman-compose \
    shadow-utils \
    sudo \
    tini \
  && dnf clean all

RUN useradd -m -s /bin/bash agent \
  && echo "agent:100000:65536" >> /etc/subuid \
  && echo "agent:100000:65536" >> /etc/subgid \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

RUN npm install --global pnpm@10 @openai/codex

COPY entrypoint.sh /usr/local/bin/dim-project-podman-entrypoint
COPY git-askpass.sh /usr/local/bin/dim-git-askpass
RUN chmod +x /usr/local/bin/dim-project-podman-entrypoint /usr/local/bin/dim-git-askpass

ENV HOME="/home/agent" \
    CODEX_HOME="/home/agent/.codex" \
    DIM_NESTED_ENGINE="podman" \
    XDG_RUNTIME_DIR="/tmp/agent-runtime"

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dim-project-podman-entrypoint"]
CMD ["bash"]
