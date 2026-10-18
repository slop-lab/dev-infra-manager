FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY core/images/ordinary-ci/package.json ./
COPY core/packages/core/dist ./node_modules/@slop-lab/dim-core
COPY core/packages/managed/dist/nativeGitAdmissionHttpClient.js \
  core/packages/managed/dist/nativeCandidatePath.js \
  core/packages/managed/dist/nativeGitAdmissionSource.js \
  core/packages/managed/dist/nativeGitCandidateLeaseClient.js \
  core/packages/managed/dist/nativeGitAttemptIssuerClient.js \
  core/packages/managed/dist/nativeGitAttemptIssuerErrors.js \
  core/packages/managed/dist/nativeGitAttemptIssuerModel.js \
  core/packages/managed/dist/nativeGitAttemptIssuerWire.js \
  core/packages/managed/dist/nativeGitCurrentAttemptProofClient.js \
  core/packages/managed/dist/nativeOrdinaryAuthorityConfig.js \
  core/packages/managed/dist/nativeOrdinaryAuthorityModel.js \
  core/packages/managed/dist/nativeOrdinaryAuthorityProtocol.js \
  core/packages/managed/dist/nativeOrdinaryBundleConfig.js \
  core/packages/managed/dist/nativeOrdinaryBundleFilesystem.js \
  core/packages/managed/dist/nativeOrdinaryBundleSnapshot.js \
  core/packages/managed/dist/nativeOrdinaryBundleState.js \
  core/packages/managed/dist/nativeOrdinaryEvent.js \
  core/packages/managed/dist/nativeOrdinaryResultProtocol.js \
  core/packages/managed/dist/nativeOrdinaryServiceCli.js \
  core/packages/managed/dist/nativeOrdinaryServiceReadiness.js \
  core/packages/managed/dist/nativeRootAdmissionActivation.js \
  core/packages/managed/dist/nativeRootAdmissionHttp.js \
  core/packages/managed/dist/nativeRootAdmissionModel.js \
  core/packages/managed/dist/nativeRootAdmissionSchema.js \
  core/packages/managed/dist/nativeRootAdmissionService.js \
  core/packages/managed/dist/nativeRootAdmissionStore.js \
  core/packages/managed/dist/nativeRootCiCandidateAssignment.js \
  core/packages/managed/dist/nativeRootCiClaimHttp.js \
  core/packages/managed/dist/nativeRootCiClaimLifecycleHttp.js \
  core/packages/managed/dist/nativeRootCiClaimLifecycleProtocol.js \
  core/packages/managed/dist/nativeRootCiClaimLifecycleRows.js \
  core/packages/managed/dist/nativeRootCiClaimLifecycleStore.js \
  core/packages/managed/dist/nativeRootCiClaimProtocol.js \
  core/packages/managed/dist/nativeRootCiClaimStore.js \
  core/packages/managed/dist/nativeRootCiDemandStore.js \
  core/packages/managed/dist/nativeRootCiEventReceiptHttp.js \
  core/packages/managed/dist/nativeRootCiEventReceiptIntegrity.js \
  core/packages/managed/dist/nativeRootCiEventReceiptModel.js \
  core/packages/managed/dist/nativeRootCiEventReceiptStore.js \
  core/packages/managed/dist/nativeRootCiProofClient.js \
  core/packages/managed/dist/nativeRootCiProofModel.js \
  core/packages/managed/dist/nativeRootCiReviewEvent.js \
  core/packages/managed/dist/nativeRootCiResultHttp.js \
  core/packages/managed/dist/nativeRootCiResultIntegrity.js \
  core/packages/managed/dist/nativeRootCiResultProofHttp.js \
  core/packages/managed/dist/nativeRootCiResultProofModel.js \
  core/packages/managed/dist/nativeRootCiResultProofStore.js \
  core/packages/managed/dist/nativeRootCiResultProtocol.js \
  core/packages/managed/dist/nativeRootCiResultReporter.js \
  core/packages/managed/dist/nativeRootCiResultStore.js \
  core/packages/managed/dist/nativeRootCiTerminalResultProofHttp.js \
  core/packages/managed/dist/nativeRootCiTerminalResultProofModel.js \
  core/packages/managed/dist/nativeRootCiTerminalResultProofStore.js \
  core/packages/managed/dist/nativeSqliteAvailability.js \
  core/packages/managed/dist/sqliteSchemaManifest.js ./
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
