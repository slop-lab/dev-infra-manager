FROM docker:29.1.3-dind-rootless

USER root
RUN apk add --no-cache su-exec \
  && chown root:root /usr/bin/newuidmap /usr/bin/newgidmap \
  && chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap
ENV HOME=/home/rootless \
    XDG_RUNTIME_DIR=/run/dim-secure-dind \
    DOCKER_HOST=unix:///run/dim-secure-dind/docker.sock
COPY entrypoint.sh /usr/local/bin/dim-secure-dind-entrypoint
COPY service.sh /usr/local/bin/dim-secure-dind
RUN chmod 0755 /usr/local/bin/dim-secure-dind-entrypoint /usr/local/bin/dim-secure-dind

ENTRYPOINT ["dim-secure-dind-entrypoint"]
