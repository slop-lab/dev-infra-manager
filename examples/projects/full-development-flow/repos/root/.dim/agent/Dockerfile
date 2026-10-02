FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS node
FROM docker@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS docker-cli
FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ARG TARGETARCH=amd64
ARG DIM_WORKSPACE_UID=1000
ARG DIM_WORKSPACE_GID=1000
ENV PATH="/home/dim-agent/.local/bin:${PATH}"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      acl bash ca-certificates curl git jq netcat-openbsd openssh-server sudo tini util-linux \
 && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
 && rm -rf /var/lib/apt/lists/* \
 && test "$DIM_WORKSPACE_UID" -ne 0 \
 && test "$DIM_WORKSPACE_GID" -ne 0 \
 && existing_group="$(getent group "$DIM_WORKSPACE_GID" | cut -d: -f1)" \
 && if test -n "$existing_group"; then \
       if test "$existing_group" != dim-agent; then \
         groupmod --new-name dim-agent "$existing_group"; \
       fi; \
     else \
       groupadd --gid "$DIM_WORKSPACE_GID" dim-agent; \
     fi \
 && existing_user="$(getent passwd "$DIM_WORKSPACE_UID" | cut -d: -f1)" \
 && if test -n "$existing_user"; then \
       if test "$existing_user" = dim-agent; then \
         usermod --gid "$DIM_WORKSPACE_GID" --home /home/dim-agent \
           --shell /usr/local/bin/dim-agent-shell dim-agent; \
       else \
         usermod --login dim-agent --gid "$DIM_WORKSPACE_GID" \
           --home /home/dim-agent --move-home --shell /usr/local/bin/dim-agent-shell "$existing_user"; \
       fi; \
     else \
       useradd --uid "$DIM_WORKSPACE_UID" --gid "$DIM_WORKSPACE_GID" \
         --home-dir /home/dim-agent --shell /usr/local/bin/dim-agent-shell dim-agent; \
     fi \
 && passwd --delete dim-agent \
 && mkdir -p /home/dim-agent \
 && chown "$DIM_WORKSPACE_UID:$DIM_WORKSPACE_GID" /home/dim-agent \
 && printf '%s\n' 'dim-agent ALL=(root) NOPASSWD: ALL' > /etc/sudoers.d/dim-agent \
 && chmod 0440 /etc/sudoers.d/dim-agent \
 && visudo --check --file=/etc/sudoers.d/dim-agent \
 && printf '%s\n' \
      'PermitRootLogin no' \
      'PubkeyAuthentication yes' \
      'AuthorizedKeysFile /home/dim-agent/.ssh/authorized_keys' \
      'AuthenticationMethods publickey' \
      'PasswordAuthentication no' \
      'PermitEmptyPasswords no' \
      'KbdInteractiveAuthentication no' \
      'PermitUserEnvironment no' \
      'AllowUsers dim-agent' \
      > /etc/ssh/sshd_config
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
COPY dim-agent-shell /usr/local/bin/dim-agent-shell
COPY start-sshd.sh /usr/local/bin/start-sshd
COPY prepare-agent-tmp.sh /usr/local/bin/prepare-agent-tmp
RUN npm install --global pnpm@10.13.1
RUN chmod 0755 /usr/local/bin/dim-agent-shell /usr/local/bin/start-sshd /usr/local/bin/prepare-agent-tmp \
 && ln -s /usr/local/lib/dim/controller-proxy/development-service-cli.js \
      /usr/local/bin/dim-development-service \
 && ln -s /usr/local/lib/dim/controller-proxy/workspace-resources-cli.js \
      /usr/local/bin/dim-workspace-resources \
 && ln -s /usr/local/lib/dim/controller-proxy/nproc-cli.js \
      /usr/local/bin/dim-nproc

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start-sshd"]
