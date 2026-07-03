FROM quay.io/podman/stable:v5.6.2

RUN dnf install -y \
    bash \
    coreutils \
    curl \
    git \
    jq \
    openssh-clients \
    shadow-utils \
    sudo \
    tini \
  && dnf clean all

RUN useradd -m -s /bin/bash agent \
  && echo "agent:100000:65536" >> /etc/subuid \
  && echo "agent:100000:65536" >> /etc/subgid \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

COPY entrypoint.sh /usr/local/bin/dev-infra-agent-podman-entrypoint
RUN chmod +x /usr/local/bin/dev-infra-agent-podman-entrypoint

ENV DEV_INFRA_NESTED_ENGINE="podman" \
    DEV_INFRA_START_DOCKERD="0" \
    XDG_RUNTIME_DIR="/tmp/agent-runtime"

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dev-infra-agent-podman-entrypoint"]
CMD ["bash"]
