FROM python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d AS python

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS source-toolchain

COPY --from=python /usr/local /usr/local

ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential ca-certificates curl docker.io git jq libsqlite3-0 openssh-client procps util-linux xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) just_target=x86_64; just_sha=6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc ;; \
      arm64) just_target=aarch64; just_sha=e28e1f18cecd45d35f9fb39ef3651dd79c0623cb29a2f375ea7a1a185ac32dc9 ;; \
      *) printf 'unsupported architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --fail --silent --show-error --location \
      --output /tmp/just.tar.gz \
      "https://github.com/casey/just/releases/download/1.43.1/just-1.43.1-${just_target}-unknown-linux-musl.tar.gz"; \
    printf '%s  %s\n' "$just_sha" /tmp/just.tar.gz | sha256sum --check; \
    tar --extract --gzip --file /tmp/just.tar.gz --directory /usr/local/bin just; \
    rm /tmp/just.tar.gz

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
