FROM quay.io/podman/stable:v5.6.2

RUN dnf clean all \
  && dnf --refresh install -y \
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

# An enclosing user namespace can make files installed by the sudo RPM appear
# to inherit its mapped UID. Restore the package's complete ownership and mode
# metadata after creating the workspace user, then secure the local policy.
RUN useradd -m -s /bin/bash dim \
  && echo "dim:100000:65536" >> /etc/subuid \
  && echo "dim:100000:65536" >> /etc/subgid \
  && echo "dim ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dim \
  && rpm --setugids sudo \
  && rpm --setperms sudo \
  && chown root:root /etc/sudoers.d /etc/sudoers.d/dim \
  && chmod 0755 /etc/sudoers.d \
  && chmod 0440 /etc/sudoers.d/dim

RUN npm install --global pnpm@10 @openai/codex

COPY entrypoint.bash /usr/local/bin/dim-project-podman-entrypoint
COPY git-askpass.sh /usr/local/bin/dim-git-askpass
COPY route-relay.mjs /usr/local/lib/dim/route-relay.mjs
RUN chmod +x /usr/local/bin/dim-project-podman-entrypoint /usr/local/bin/dim-git-askpass

ENV HOME="/home/dim" \
    CODEX_HOME="/home/dim/.codex" \
    DIM_NESTED_ENGINE="podman" \
    XDG_RUNTIME_DIR="/tmp/dim-runtime"

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dim-project-podman-entrypoint"]
CMD ["bash"]
