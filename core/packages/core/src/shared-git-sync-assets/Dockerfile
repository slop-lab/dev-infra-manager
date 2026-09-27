FROM python:3.13.7-slim@sha256:5f55cdf0c5d9dc1a415637a5ccc4a9e18663ad203673173b8cda8f8dcacef689
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 dim-git-sync \
 && useradd --system --uid 10001 --gid dim-git-sync --home-dir /var/lib/dim-git-sync dim-git-sync \
 && install -d -o dim-git-sync -g dim-git-sync -m 0700 /var/lib/dim-git-sync
COPY protocol.py git_sync.py server.py /opt/dim-git-sync/
RUN chmod 0555 /opt/dim-git-sync/protocol.py /opt/dim-git-sync/git_sync.py /opt/dim-git-sync/server.py
USER 10001:10001
WORKDIR /var/lib/dim-git-sync
VOLUME ["/var/lib/dim-git-sync"]
ENTRYPOINT ["python3", "/opt/dim-git-sync/server.py", "/var/lib/dim-git-sync/config.json"]
