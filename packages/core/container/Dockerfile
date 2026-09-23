ARG NODE_IMAGE=node:24.13.1-bookworm-slim@sha256:18f02fb9b82f32e230addf34ed1f7ca863b9a9a7a95c16380107f92852d97f89
FROM ${NODE_IMAGE}
RUN useradd --create-home --uid 10001 dim-broker
COPY package/ /opt/dim-control-plane/
USER dim-broker
ENTRYPOINT ["node", "/opt/dim-control-plane/dist/brokerCli.js"]
