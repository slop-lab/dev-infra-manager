FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY core/images/ordinary-ci/package.json core/images/ordinary-ci/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY core/packages/core/dist ./node_modules/@slop-lab/dim-core
COPY core/packages/native-git/dist ./node_modules/@slop-lab/dim-native-git
COPY core/packages/managed/dist/ci ./ci
COPY core/packages/managed/dist/nativeCandidatePath.js \
  core/packages/managed/dist/nativeGitAdmissionHttpClient.js \
  core/packages/managed/dist/nativeOrdinaryAuthorityConfig.js \
  core/packages/managed/dist/nativeOrdinaryAuthorityModel.js \
  core/packages/managed/dist/nativeOrdinaryAuthorityProtocol.js \
  core/packages/managed/dist/nativeOrdinaryBundleConfig.js \
  core/packages/managed/dist/nativeOrdinaryServiceCli.js \
  core/packages/managed/dist/nativeOrdinaryServiceReadiness.js ./
COPY core/images/ordinary-ci/dim-service /usr/local/bin/dim-service

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
