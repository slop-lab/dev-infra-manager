FROM python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d AS python

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS source-toolchain

COPY --from=python /usr/local /usr/local

ARG TARGETARCH=amd64

COPY install-system-tools.bash /usr/local/libexec/dim-install-source-system-tools.bash
RUN bash /usr/local/libexec/dim-install-source-system-tools.bash

COPY install-just.bash /usr/local/libexec/dim-install-pinned-just.bash
RUN bash /usr/local/libexec/dim-install-pinned-just.bash /usr/local/bin "$TARGETARCH"

RUN npm install --global pnpm@10.13.1 \
  && npm cache clean --force \
  && test "$(node --version)" = "v24.19.0" \
  && test "$(python3 --version)" = "Python 3.13.7" \
  && test "$(pnpm --version)" = "10.13.1"

COPY run.bash /usr/local/bin/dim-source-gate-run
RUN chmod 0555 /usr/local/bin/dim-source-gate-run

WORKDIR /workspace
CMD ["sleep", "infinity"]

# Reuse the pinned fixture toolchain while executing the complete suite with
# the selected Node runtime. Both bases use Debian bookworm.
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS node26-runtime

FROM source-toolchain AS source-node-26
COPY --from=node26-runtime /usr/local/bin/node /usr/local/bin/node
RUN test "$(node --version)" = "v26.5.0"

FROM source-toolchain AS source-node-24
