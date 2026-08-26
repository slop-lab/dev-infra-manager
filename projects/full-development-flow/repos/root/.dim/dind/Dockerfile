FROM docker:29.1.3-dind

# Reproduce the official rootless variant on top of the ordinary DinD image
# without inheriting file-capability xattrs that gVisor cannot register in its
# nested image store. newuidmap/newgidmap use their setuid fallback below.
RUN apk add --no-cache iproute2 fuse-overlayfs slirp4netns \
  && mkdir -p /run/user \
  && chmod 1777 /run/user \
  && adduser -h /home/rootless -g 'Rootless' -D -u 1000 rootless \
  && echo 'rootless:100000:65536' >> /etc/subuid \
  && echo 'rootless:100000:65536' >> /etc/subgid

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

RUN apk add --no-cache su-exec
COPY entrypoint.sh /usr/local/bin/dim-rootless-dind-entrypoint
RUN chmod 0755 /usr/local/bin/dim-rootless-dind-entrypoint

ENTRYPOINT ["dim-rootless-dind-entrypoint"]
