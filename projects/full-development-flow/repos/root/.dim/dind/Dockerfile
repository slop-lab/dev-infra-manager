FROM docker:29.1.3-cli

# Assemble DinD without file-capability xattrs: nested gVisor image stores
# cannot register them, while the uid-map helpers support a setuid fallback.
RUN apk add --no-cache \
    btrfs-progs e2fsprogs e2fsprogs-extra fuse-overlayfs git ip6tables \
    iproute2 iptables iptables-legacy openssl pigz shadow-libs slirp4netns \
    su-exec xfsprogs xz zfs \
  && mkdir -p /run/user \
  && chmod 1777 /run/user \
  && adduser -h /home/rootless -g 'Rootless' -D -u 1000 rootless \
  && echo 'rootless:100000:65536' >> /etc/subuid \
  && echo 'rootless:100000:65536' >> /etc/subgid

RUN set -eu; \
  case "$(apk --print-arch)" in \
    x86_64) shadow_sha256=dba2556ce07825e4da14383e40968f4569b89b69c558f2589e005761a46d121e ;; \
    aarch64) shadow_sha256=92dbdb422814ffe64e4e7a943eebdc4c373e981743c01ce2bfdb4755f4072c7c ;; \
    *) echo "unsupported rootless DinD architecture" >&2; exit 2 ;; \
  esac; \
  wget -O /tmp/shadow-subids.apk \
    "https://dl-cdn.alpinelinux.org/alpine/v3.23/community/$(apk --print-arch)/shadow-subids-4.18.0-r0.apk"; \
  echo "$shadow_sha256  /tmp/shadow-subids.apk" | sha256sum -c -; \
  tar -xzf /tmp/shadow-subids.apk -C / usr/bin/newuidmap usr/bin/newgidmap; \
  rm /tmp/shadow-subids.apk; \
  chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

RUN set -eu; \
  case "$(apk --print-arch)" in \
    x86_64) docker_arch=x86_64 ;; \
    aarch64) docker_arch=aarch64 ;; \
    *) echo "unsupported rootless DinD architecture" >&2; exit 2 ;; \
  esac; \
  wget -O /tmp/docker.tgz \
    "https://download.docker.com/linux/static/stable/$docker_arch/docker-29.1.3.tgz"; \
  tar -xzf /tmp/docker.tgz --strip-components 1 -C /usr/local/bin \
    --exclude docker/docker; \
  rm /tmp/docker.tgz; \
  dockerd --version

RUN set -eu; \
  wget -O /usr/local/bin/dockerd-entrypoint.sh \
    "https://raw.githubusercontent.com/docker-library/docker/a6130b3dd7f1c3e938c497c29e671b3532de2bc9/29/dind/dockerd-entrypoint.sh"; \
  echo 'a63266692950dec182182893c5d03d575e88d9246dc81987c9cfab21da1f29de  /usr/local/bin/dockerd-entrypoint.sh' | sha256sum -c -; \
  chmod 0755 /usr/local/bin/dockerd-entrypoint.sh

RUN set -eu; \
  case "$(apk --print-arch)" in \
    x86_64) \
      rootless_arch=x86_64; \
      rootless_sha256=32dc3dd0d8b512ccf30a7efe84d360b5ade65ac4fec92a2a5ad0fe791da6ab0d \
      ;; \
    aarch64) \
      rootless_arch=aarch64; \
      rootless_sha256=50fca361239fda2b89a774abf658b32e36460486cf00682a6a020330f6e159b2 \
      ;; \
    *) echo "unsupported rootless DinD architecture" >&2; exit 2 ;; \
  esac; \
  wget -O /tmp/rootless.tgz \
    "https://download.docker.com/linux/static/stable/$rootless_arch/docker-rootless-extras-29.1.3.tgz"; \
  echo "$rootless_sha256  /tmp/rootless.tgz" | sha256sum -c -; \
  tar -xzf /tmp/rootless.tgz --strip-components 1 -C /usr/local/bin \
    docker-rootless-extras/rootlesskit docker-rootless-extras/vpnkit; \
  rm /tmp/rootless.tgz; \
  rootlesskit --version; \
  vpnkit --help >/dev/null

RUN mkdir -p /home/rootless/.local/share/docker /mnt/workspace-shared-dind \
  && chown -R rootless:rootless /home/rootless/.local/share/docker \
  && chmod 1777 /mnt/workspace-shared-dind \
  && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

VOLUME /home/rootless/.local/share/docker

COPY entrypoint.sh /usr/local/bin/dim-rootless-dind-entrypoint
RUN chmod 0755 /usr/local/bin/dim-rootless-dind-entrypoint

ENTRYPOINT ["dim-rootless-dind-entrypoint"]
