FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY core/images/ordinary-ci/package.json ./
COPY core/packages/core/dist/errors.js \
  core/packages/core/dist/nativeGitAdmissionHttpClient.js \
  core/packages/core/dist/nativeOrdinaryAuthorityConfig.js \
  core/packages/core/dist/nativeOrdinaryAuthorityModel.js \
  core/packages/core/dist/nativeOrdinaryAuthorityProtocol.js \
  core/packages/core/dist/nativeOrdinaryBundleConfig.js \
  core/packages/core/dist/nativeOrdinaryBundleFilesystem.js \
  core/packages/core/dist/nativeOrdinaryBundleSnapshot.js \
  core/packages/core/dist/nativeOrdinaryBundleState.js \
  core/packages/core/dist/nativeOrdinaryServiceCli.js \
  core/packages/core/dist/nativeOrdinaryServiceReadiness.js \
  core/packages/core/dist/nativeRootAdmissionModel.js \
  core/packages/core/dist/nativeRootAdmissionSchema.js \
  core/packages/core/dist/nativeRootAdmissionService.js \
  core/packages/core/dist/nativeRootAdmissionStore.js \
  core/packages/core/dist/nativeRootCiEventReceiptHttp.js \
  core/packages/core/dist/nativeRootCiEventReceiptIntegrity.js \
  core/packages/core/dist/nativeRootCiEventReceiptModel.js \
  core/packages/core/dist/nativeRootCiEventReceiptStore.js \
  core/packages/core/dist/nativeRootCiProofClient.js \
  core/packages/core/dist/nativeRootCiProofModel.js \
  core/packages/core/dist/nativeRootCiReviewEvent.js \
  core/packages/core/dist/sqliteSchemaManifest.js ./
COPY core/images/ordinary-ci/dim-service /usr/local/bin/dim-service

RUN groupadd --gid 10002 dim-service \
  && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dim-service \
  && install -d -o 10002 -g 10002 -m 0750 /var/lib/dim-ordinary-ci \
  && chmod 0444 /usr/local/lib/dim/*.js /usr/local/lib/dim/package.json \
  && chmod 0555 /usr/local/lib/dim/nativeOrdinaryServiceCli.js \
  && chmod 0555 /usr/local/bin/dim-service

ENV HOME=/nonexistent \
    NODE_ENV=production

USER 10002:10002
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dim-service"]
