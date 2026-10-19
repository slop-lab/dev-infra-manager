FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY packages/control-plane/plugins/ci/image/package.json packages/control-plane/plugins/ci/image/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY packages/control-plane/plugins/native-git/dist ./node_modules/@slop-lab/dim-plugin-control-plane-native-git
COPY core/packages/managed/dist/ci/config.js \
  core/packages/managed/dist/ci/execution.js \
  core/packages/managed/dist/ci/query.js \
  core/packages/managed/dist/ci/service.js \
  core/packages/managed/dist/ci/source.js \
  core/packages/managed/dist/ci/state.js \
  core/packages/managed/dist/ci/store.js ./ci
COPY core/packages/managed/dist/nativeGitAdmissionHttpClient.js \
  core/packages/managed/dist/nativeOrdinaryServiceCli.js \
  core/packages/managed/dist/nativeOrdinaryServiceReadiness.js ./
COPY packages/control-plane/plugins/ci/image/dim-service /usr/local/bin/dim-service

RUN groupadd --gid 10002 dim-service \
  && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dim-service \
  && install -d -o 10002 -g 10002 -m 0750 /var/lib/dim-ordinary-ci \
  && chmod 0444 /usr/local/lib/dim/*.js /usr/local/lib/dim/package.json /usr/local/lib/dim/package-lock.json \
  && chmod 0555 /usr/local/lib/dim/nativeOrdinaryServiceCli.js \
  && chmod 0555 /usr/local/bin/dim-service

ENV HOME=/nonexistent \
    NODE_ENV=production

USER 10002:10002
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dim-service"]
