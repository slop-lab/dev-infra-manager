FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /usr/local/lib/dim

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY modules/ ./node_modules/
COPY dim-service /usr/local/bin/dim-service

RUN groupadd --gid 10002 dim-service \
  && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dim-service \
  && install -d -o 10002 -g 10002 -m 0750 /var/lib/dim-execution \
  && chmod 0444 /usr/local/lib/dim/package.json /usr/local/lib/dim/package-lock.json \
  && chmod 0555 /usr/local/lib/dim/node_modules/@slop-lab/dim-control-plane-plugin-execution-scheduler/cli.js \
  && chmod 0555 /usr/local/bin/dim-service

ENV HOME=/nonexistent \
    NODE_ENV=production

USER 10002:10002
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dim-service"]
