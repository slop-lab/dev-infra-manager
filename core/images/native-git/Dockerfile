FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY core/images/native-git/package.json core/images/native-git/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY core/packages/native-git/dist/admission-verifier.js \
  core/packages/native-git/dist/bundle-config.js \
  core/packages/native-git/dist/candidate-execution-schema.js \
  core/packages/native-git/dist/config.js \
  core/packages/native-git/dist/native-bundle-state.js \
  core/packages/native-git/dist/native-idle-service.js \
  core/packages/native-git/dist/ordinary-admission-http.js \
  core/packages/native-git/dist/serviceCli.js \
  core/packages/native-git/dist/serviceReadiness.js \
  core/packages/native-git/dist/storage-owner.js ./
COPY core/images/native-git/dim-service /usr/local/bin/dim-service

RUN groupadd --gid 10001 dim-service \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dim-service \
  && install -d -o 10001 -g 10001 -m 0750 /var/lib/dim-native-git \
  && chmod 0444 /usr/local/lib/dim/*.js /usr/local/lib/dim/package.json /usr/local/lib/dim/package-lock.json \
  && chmod 0555 /usr/local/lib/dim/serviceCli.js \
  && chmod 0555 /usr/local/bin/dim-service

ENV HOME=/nonexistent \
    NODE_ENV=production

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dim-service"]
