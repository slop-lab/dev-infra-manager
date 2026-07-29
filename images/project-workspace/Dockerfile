FROM docker:29.1.3-dind

ARG DIM_UID=1000
ARG DIM_GID=1000

RUN apk add --no-cache bash ca-certificates coreutils curl git jq just nodejs npm openssh-client shadow sudo tini \
  && groupadd --non-unique --gid "${DIM_GID}" dim \
  && useradd --non-unique --uid "${DIM_UID}" --gid dim --create-home --shell /bin/bash dim \
  && echo "dim ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dim \
  && chmod 0440 /etc/sudoers.d/dim

ENV HOME=/home/dim \
    CODEX_HOME=/home/dim/.codex \
    DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST=unix:///var/run/docker.sock \
    PATH=/home/dim/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN npm install --global pnpm@10 @openai/codex

COPY images/project-workspace/entrypoint.bash /usr/local/bin/dim-project-entrypoint
COPY images/project-workspace/git-askpass.sh /usr/local/bin/dim-git-askpass
COPY images/project-workspace/route-relay.mjs /usr/local/lib/dim/route-relay.mjs
COPY packages/controller-proxy/dist /usr/local/lib/dim/controller-proxy
RUN chmod +x /usr/local/bin/dim-project-entrypoint /usr/local/bin/dim-git-askpass \
  /usr/local/lib/dim/controller-proxy/cli.js \
  && ln -s /usr/local/lib/dim/controller-proxy/cli.js /usr/local/bin/dim-controller-proxy

WORKDIR /workspace
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/dim-project-entrypoint"]
CMD ["bash"]
