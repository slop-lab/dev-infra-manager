FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY packages/control-plane/plugins/native-git/image/package.json packages/control-plane/plugins/native-git/image/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    git=1:2.39.5-0+deb12u3 git-man=1:2.39.5-0+deb12u3 \
  && test "$(git --version)" = "git version 2.39.5" \
  && rm -rf /var/lib/apt/lists/*

COPY packages/control-plane/core/dist ./node_modules/@slop-lab/dim-control-plane
COPY packages/control-plane/plugins/native-git/dist ./node_modules/@slop-lab/dim-plugin-control-plane-native-git
COPY packages/control-plane/plugins/ci-workflows/dist ./node_modules/@slop-lab/dim-plugin-control-plane-ci-workflows
COPY core/packages/managed/dist/nativeGitServiceCli.js core/packages/managed/dist/controlPlaneServicePair.js ./
COPY core/packages/managed/dist/ci/config.js ./ci/config.js
COPY packages/control-plane/plugins/native-git/image/dim-service /usr/local/bin/dim-service

RUN groupadd --gid 10001 dim-service \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dim-service \
  && install -d -o 10001 -g 10001 -m 0750 /var/lib/dim-native-git \
  && chmod 0444 /usr/local/lib/dim/*.js /usr/local/lib/dim/package.json /usr/local/lib/dim/package-lock.json \
  && chmod 0555 /usr/local/lib/dim/nativeGitServiceCli.js \
  && chmod 0555 /usr/local/bin/dim-service

ENV HOME=/nonexistent \
    NODE_ENV=production

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dim-service"]
