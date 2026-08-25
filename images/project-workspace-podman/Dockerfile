FROM quay.io/podman/stable:v5.6.2

RUN for attempt in 1 2 3; do \
    dnf clean all; \
    dnf --refresh install -y \
    bash \
    coreutils \
    curl \
    git \
    jq \
    just \
    openssh-clients \
    podman-compose \
    shadow-utils \
    sudo \
    tini \
    && break; \
    test "$attempt" -lt 3 || exit 1; \
    sleep 5; \
  done \
  && dnf clean all

RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz \
  && echo "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  /tmp/node.tar.xz" | sha256sum --check \
  && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
  && rm /tmp/node.tar.xz \
  && ln -s /usr/bin/podman /usr/local/bin/docker

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

COPY core/images/project-workspace-podman/entrypoint.bash /usr/local/bin/dim-project-podman-entrypoint
COPY core/images/project-workspace-podman/git-askpass.sh /usr/local/bin/dim-git-askpass
COPY core/images/project-workspace-podman/route-relay.mjs /usr/local/lib/dim/route-relay.mjs
COPY core/packages/controller-proxy/dist /usr/local/lib/dim/controller-proxy
RUN chmod +x /usr/local/bin/dim-project-podman-entrypoint /usr/local/bin/dim-git-askpass \
  /usr/local/lib/dim/controller-proxy/cli.js \
  && ln -s /usr/local/lib/dim/controller-proxy/cli.js /usr/local/bin/dim-controller-proxy \
  && node --version \
  && just --version

ENV HOME="/home/dim" \
    CODEX_HOME="/home/dim/.codex" \
    DIM_NESTED_ENGINE="podman" \
    XDG_RUNTIME_DIR="/tmp/dim-runtime"

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dim-project-podman-entrypoint"]
CMD ["bash"]
